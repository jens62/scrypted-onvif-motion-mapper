// Isoliert dieselbe Reihenfolge wie main.ts's connect(), gegen einen Fake-Cam, der genauso
// tickt wie die echte onvif-Bibliothek (newListener -> setImmediate -> _eventRequest).
const { EventEmitter } = require('events');
const order = [];

class FakeCam extends EventEmitter {
  constructor(options, callback) {
    super();
    this.on('newListener', (name) => {
      if (name === 'event' && this.listeners('event').length === 0) {
        order.push('eventRequestStarted (PullPoint subscription)');
        setImmediate(() => {
          this.emit('event', {
            topic: { _: 'tns1:VideoAnalytics/tnsaxis:MotionDetection' },
            message: { message: { data: { simpleItem: { $: { Name: 'motion', Value: 1 } } } } },
          }, '<xml/>');
        });
      }
    });
    order.push('Cam constructed');
    setImmediate(() => { order.push('connect callback fires'); callback(null); });
  }
}

// --- Nachbau von connect() wie in main.ts v0.0.4 (nach der Korrektur) ---
function connectFixed(onMotion) {
  let cam;
  cam = new FakeCam({}, (err) => {
    order.push('onConnected: attach event listener');
    cam.on('event', (event) => onMotion(event));
  });
  cam.on('error', () => {});
}

// --- Nachbau der alten, fehlerhaften Reihenfolge (v0.0.2/0.0.3) ---
function connectBuggy(onMotion) {
  let cam;
  cam = new FakeCam({}, (err) => { order.push('onConnected (buggy: listener already attached earlier)'); });
  cam.on('event', (event) => onMotion(event));
  cam.on('error', () => {});
}

async function run(name, fn) {
  order.length = 0;
  let motionSeen = false;
  fn(() => motionSeen = true);
  await new Promise(r => setTimeout(r, 20));
  console.log(`\n=== ${name} ===`);
  order.forEach((o, i) => console.log(` ${i + 1}. ${o}`));
  console.log('Bewegungsereignis empfangen:', motionSeen);
  return motionSeen;
}

(async () => {
  const fixedOk = await run('v0.0.4 (Listener erst nach Verbindung)', connectFixed);
  const buggyOk = await run('v0.0.2/0.0.3 (Listener sofort, alter Fehler)', connectBuggy);
  console.log('\nErwartung: fixed=true (Ereignis kommt an), buggy zeigt, wie die Anmeldung VOR dem Verbindungsaufbau lostickt.');
  if (!fixedOk) { console.error('FEHLER: die reparierte Reihenfolge liefert kein Ereignis!'); process.exit(1); }
  console.log('OK: reparierte Reihenfolge liefert das Ereignis zuverlässig.');
})();
