// ONVIF Motion Mapper
//
// Maps an arbitrary ONVIF PullPoint event (a topic + a named boolean item) onto a MotionSensor
// device. Useful for cameras whose motion topic the built-in @scrypted/onvif plugin does not
// recognize (its topic list is hardcoded to MotionAlarm and RuleEngine/CellMotionDetector/Motion;
// see plugins/onvif/src/onvif-api.ts in koush/scrypted). An older Axis camera, for example, may
// only report tns1:VideoAnalytics/tnsaxis:MotionDetection with item "motion" = 1/0, which is not
// one of those two.
//
// This plugin does NOT attach itself to the real camera. It only produces a device that implements
// MotionSensor. Use the Dummy Switch plugin's "Custom Motion Sensor" extension (mixin) on the real
// camera and point it at the device created here - that mixin already does the attaching.
//
// Each device you create here opens its own ONVIF PullPoint subscription to the camera, in addition
// to whatever the built-in ONVIF plugin already has open for the same camera (if you use it for
// video too). On a slow/older camera that is already close to its connection limit, this adds load;
// watch for HTTP 503 responses if the camera was already showing them.
import sdk, {
    DeviceCreator, DeviceCreatorSettings, DeviceProvider, MotionSensor, Online, ScryptedDeviceBase,
    ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import onvifLib from 'onvif';
import { CombinedMotion } from './combined-motion';

const { Cam } = onvifLib as any;
const { deviceManager } = sdk;

// Idle watchdog: if literally nothing arrives (not even non-matching events) for this long,
// force a reconnect. This is a safety net, not the normal reconnect path - the onvif library
// already renews the PullPoint subscription and retries on its own (see node_modules/onvif's
// events.js: Cam.prototype._eventRequest/_eventPull/_restartEventRequest).
const WATCHDOG_IDLE_MS = 30 * 60 * 1000;
const WATCHDOG_CHECK_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 15 * 1000;

// Same helper as plugins/onvif/src/onvif-api.ts: strips the namespace prefix from each path
// segment of an ONVIF topic, e.g. "tns1:VideoAnalytics/tnsaxis:MotionDetection" becomes
// "VideoAnalytics/MotionDetection".
function stripNamespaces(topic: string): string {
    let output = '';
    const parts = topic.split('/');
    for (let index = 0; index < parts.length; index++) {
        const stringNoNamespace = parts[index].split(':').pop();
        output += output.length === 0 ? stringNoNamespace : '/' + stringNoNamespace;
    }
    return output;
}

// The topic setting accepts either a plain substring (matched with .includes(), same as the
// built-in plugin does for its own hardcoded topics) or a /regex/ or /regex/flags for more precise
// matching. Falls back to substring matching if the regex is invalid, so a typo doesn't silently
// match nothing.
function parseTopicPattern(pattern: string): (topic: string) => boolean {
    const trimmed = (pattern || '').trim();
    const m = /^\/(.*)\/([a-z]*)$/i.exec(trimmed);
    if (m) {
        try {
            const re = new RegExp(m[1], m[2]);
            return (topic: string) => re.test(topic);
        }
        catch (e) {
            // invalid regex: fall through to substring matching below
        }
    }
    return (topic: string) => !!trimmed && topic.includes(trimmed);
}

// Multiple connection-related settings (host, port, username, password, ...) are often saved
// together as separate fields in one go. Without debouncing, each field's onPut would tear down
// and rebuild the ONVIF connection on its own, needlessly repeating the connection attempt (and
// on a slow camera, its retries) once per field.
const RECONNECT_DEBOUNCE_MS = 500;

class OnvifMotionMapperDevice extends ScryptedDeviceBase implements MotionSensor, Online, Settings {
    cam: any;
    motionTimeout: NodeJS.Timeout;
    reconnectTimeout: NodeJS.Timeout;
    reconnectDebounce: NodeJS.Timeout;
    watchdogInterval: NodeJS.Timeout;
    lastEventAt = 0;
    destroyed = false;
    svgNoticeLogged = false;
    topicTest: (topic: string) => boolean = () => false;
    // only used with the "Combine Matched Topics" setting: one on/off state per matched topic
    combined = new CombinedMotion(motion => this.motionDetected = motion);

    storageSettings = new StorageSettings(this, {
        host: {
            title: 'Host / IP Address',
            description: 'The camera\'s ONVIF address, same as you would enter in the ONVIF camera plugin.',
            type: 'string',
            onPut: () => this.scheduleReconnect(),
        },
        port: {
            title: 'Port',
            type: 'number',
            defaultValue: 80,
            onPut: () => this.scheduleReconnect(),
        },
        https: {
            title: 'Use HTTPS',
            type: 'boolean',
            defaultValue: false,
            onPut: () => this.scheduleReconnect(),
        },
        username: {
            title: 'Username',
            type: 'string',
            onPut: () => this.scheduleReconnect(),
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: () => this.scheduleReconnect(),
        },
        topic: {
            title: 'Event Topic',
            description: 'Substring to match after ONVIF namespaces are stripped (e.g. "VideoAnalytics/MotionDetection"), '
                + 'or a /regex/ with optional flags. Turn on "Log All Events" below and watch the console '
                + 'to see the exact topics this camera actually sends.',
            type: 'string',
            onPut: () => this.rebuildTopicTest(),
        },
        combine: {
            title: 'Combine Matched Topics (any active)',
            description: 'For a /regex/ Event Topic that matches several events, e.g. '
                + '/^(RuleEngine\\/MotionRegionDetector\\/Motion|CameraApplicationPlatform\\/AnimalDetector\\/Any)$/ (the camera\'s own motion plus an animal detector). '
                + 'Every matched topic keeps its own on/off state, and motion is reported as long as at least one of them is on. '
                + 'A false value only switches off its own topic. Motion Reset then counts for each topic on its own. '
                + 'Off (default): one shared flag, the last matched event wins. Leave Data Item Name empty if the topics '
                + 'use different item names.',
            type: 'boolean',
            defaultValue: false,
            onPut: () => this.resetMotionState(),
        },
        itemName: {
            title: 'Data Item Name',
            description: 'The Name of the boolean item inside <tt:Data> for a matching topic (e.g. "motion", '
                + '"IsMotion", "State", "active"). Leave empty to match on the topic alone, regardless of item name.',
            type: 'string',
        },
        invert: {
            title: 'Invert Value',
            description: 'Enable if the camera reports a truthy value while there is NO motion (rare).',
            type: 'boolean',
            defaultValue: false,
        },
        motionTimeout: {
            title: 'Motion Reset (seconds)',
            description: 'Some cameras only send a "motion started" event and never a clean "stopped" event. '
                + 'If no new matching true event arrives within this many seconds, motion is cleared automatically. '
                + 'Enter 0 to only clear on an explicit false/0 value from the camera.',
            type: 'number',
            defaultValue: 30,
        },
        debugLog: {
            title: 'Log All Events',
            description: 'Log every ONVIF event this device receives (topic, item name, value) to the console, '
                + 'matching or not (SVG overlay pictures, item "svgframe", are left out). Noisy - use it only to find the '
                + 'right Topic/Item Name, switch it on shortly before the test and off right after it, then copy the console from the top.',
            type: 'boolean',
            defaultValue: false,
        },
    });

    constructor(nativeId: string) {
        super(nativeId);
        this.motionDetected = false;
        this.online = false;
        this.rebuildTopicTest();
        this.connect();
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    rebuildTopicTest() {
        this.topicTest = parseTopicPattern(this.storageSettings.values.topic as string);
        this.resetMotionState();
    }

    // Start from "no motion" when the topic or the combine mode changes, so no stale state is left.
    resetMotionState() {
        this.combined.clear();
        this.clearMotion();
    }

    scheduleReconnect() {
        clearTimeout(this.reconnectDebounce);
        this.reconnectDebounce = setTimeout(() => this.connect(), RECONNECT_DEBOUNCE_MS);
    }

    triggerMotion() {
        this.motionDetected = true;
        clearTimeout(this.motionTimeout);
        const seconds = Number(this.storageSettings.values.motionTimeout) || 0;
        if (seconds > 0)
            this.motionTimeout = setTimeout(() => this.motionDetected = false, seconds * 1000);
    }

    clearMotion() {
        this.motionDetected = false;
        clearTimeout(this.motionTimeout);
    }

    handleEvent(event: any, xml: string) {
        this.lastEventAt = Date.now();
        const debug = this.storageSettings.values.debugLog;

        // same guard as onvif-api.ts: some cameras (notably some Axis firmwares) occasionally send
        // notifications without a simpleItem; ignore those instead of throwing.
        if (!event?.message?.message?.data?.simpleItem?.$) {
            if (debug)
                this.console.log('onvif event without a simpleItem, ignoring:\n', xml);
            return;
        }

        const item = event.message.message.data.simpleItem.$;
        const dataValue = item.Value;
        const eventTopic = stripNamespaces(event.topic._);

        // Axis Object Analytics sends an SVG picture of its overlay several times a second
        // (topic CameraApplicationPlatform/ObjectAnalytics/xinternal_data, item "svgframe"). Logged, it
        // fills the console and pushes the interesting events out of its buffer. It is still matched below.
        const noisyItem = item.Name === 'svgframe';
        if (debug && noisyItem && !this.svgNoticeLogged) {
            this.svgNoticeLogged = true;
            this.console.log('Log All Events: items named "svgframe" (SVG overlay pictures, very noisy) are not logged.');
        }
        if (debug && !noisyItem)
            this.console.log(`onvif event: topic="${eventTopic}" item="${item.Name}" value=${JSON.stringify(dataValue)} (${typeof dataValue})`);

        if (!this.topicTest(eventTopic))
            return;
        const itemName = ((this.storageSettings.values.itemName as string) || '').trim();
        if (itemName && item.Name !== itemName)
            return;

        let truthy = !!dataValue;
        if (this.storageSettings.values.invert)
            truthy = !truthy;

        if (this.storageSettings.values.combine) {
            const seconds = Number(this.storageSettings.values.motionTimeout) || 0;
            this.combined.set(eventTopic, truthy, seconds * 1000);
            if (debug)
                this.console.log(`-> matched ${eventTopic} ${truthy ? 'ON' : 'OFF'}, active topics: `
                    + `[${this.combined.topics.join(', ')}], motion ${this.combined.motion ? 'ON' : 'OFF'}`);
            return;
        }

        if (debug)
            this.console.log(`-> matched, motion ${truthy ? 'START' : 'STOP'}`);

        if (truthy)
            this.triggerMotion();
        else
            this.clearMotion();
    }

    connect() {
        this.disconnect();
        if (this.destroyed)
            return;

        const v = this.storageSettings.values as any;
        if (!v.host) {
            this.console.warn('Host not configured yet, not connecting.');
            return;
        }

        let cam: any;
        try {
            cam = new Cam({
                hostname: v.host,
                port: v.port || (v.https ? 443 : 80),
                username: v.username,
                password: v.password,
                useSecure: !!v.https,
                timeout: 20000,
            }, (err: Error) => {
                if (this.destroyed || this.cam !== cam)
                    return;
                if (err) {
                    this.console.error(`ONVIF connection failed, retrying in ${RECONNECT_DELAY_MS / 1000}s:`, err.message || err);
                    this.online = false;
                    this.reconnectTimeout = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
                    return;
                }
                this.online = true;
                this.console.log('ONVIF connected. Listening for events (attaching the "event" listener starts the PullPoint subscription automatically).');
                // Attaching these listeners only NOW, after the camera is actually connected, is
                // deliberate. The onvif library hooks its own 'newListener' event and kicks off
                // _eventRequest()/createPullPointSubscription() the moment something listens for
                // 'event'. Attaching it immediately after `new Cam(...)` (before the connection
                // callback fires) races that subscription against Cam's own async connect() -
                // the subscription request goes out before the camera's Events service address is
                // even known, and silently yields a connection with zero events ever arriving.
                cam.on('event', (event: any, xml: string) => this.handleEvent(event, xml));
                cam.on('eventsError', (e: Error) => this.console.warn('ONVIF events error:', e?.message || e));
            });
        }
        catch (e) {
            this.console.error('ONVIF connection threw synchronously, retrying:', e);
            this.reconnectTimeout = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
            return;
        }

        // Attached immediately (unlike 'event'/'eventsError' above): Node's EventEmitter throws an
        // uncaught exception if an 'error' event fires with no listener at all, and Cam can emit
        // 'error' during the connection itself, before the callback above ever runs.
        cam.on('error', (e: Error) => this.console.warn('ONVIF error:', e?.message || e));

        this.cam = cam;
        this.lastEventAt = 0;

        clearInterval(this.watchdogInterval);
        this.watchdogInterval = setInterval(() => {
            if (this.lastEventAt && Date.now() - this.lastEventAt > WATCHDOG_IDLE_MS) {
                this.console.warn(`no ONVIF events at all in ${Math.round(WATCHDOG_IDLE_MS / 60000)} minutes, reconnecting as a precaution.`);
                this.connect();
            }
        }, WATCHDOG_CHECK_MS);
    }

    disconnect() {
        clearTimeout(this.reconnectTimeout);
        clearInterval(this.watchdogInterval);
        // A "false" can be missed while disconnected; forget the combined states instead of keeping
        // motion on forever. (Only touches motion if the combine mode had something active.)
        this.combined.clear();
        if (this.cam) {
            this.cam.removeAllListeners('event');
            this.cam.removeAllListeners('eventsError');
            this.cam.removeAllListeners('error');
            try {
                this.cam.unsubscribe(() => { });
            }
            catch (e) {
                // best effort; the camera may already be unreachable
            }
            this.cam = undefined;
        }
        this.online = false;
    }

    release() {
        this.destroyed = true;
        clearTimeout(this.motionTimeout);
        this.combined.clear();
        clearTimeout(this.reconnectDebounce);
        this.disconnect();
    }
}

class OnvifMotionMapperProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    devices = new Map<string, OnvifMotionMapperDevice>();

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'name',
                title: 'Name',
                placeholder: 'e.g. M1054 ONVIF Motion',
            },
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = 'onvifMotionMapper:' + Math.random().toString(36).slice(2);
        const name = settings.name?.toString() || 'ONVIF Motion Mapper';

        await deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            interfaces: [
                ScryptedInterface.MotionSensor,
                ScryptedInterface.Online,
                ScryptedInterface.Settings,
            ],
            type: ScryptedDeviceType.Sensor,
        });

        return nativeId;
    }

    async getDevice(nativeId: string) {
        let ret = this.devices.get(nativeId);
        if (!ret) {
            ret = new OnvifMotionMapperDevice(nativeId);
            this.devices.set(nativeId, ret);
        }
        return ret;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        const device = this.devices.get(nativeId);
        device?.release();
        this.devices.delete(nativeId);
    }
}

export default OnvifMotionMapperProvider;
