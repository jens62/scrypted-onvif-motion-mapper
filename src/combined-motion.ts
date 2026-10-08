// "Any matched topic is active": motion state for a device whose Event Topic matches several ONVIF
// events (e.g. the camera's own motion and an animal detector).
//
// Every matched topic keeps its own on/off state, and motion is reported as long as at least one
// topic is on. A "false" only removes its own topic. An optional reset time applies to each topic on
// its own (counted from that topic's last "true"), so a topic that went quiet cannot hold motion on and
// a fresh event of another topic is not cut short.
//
// No Scrypted imports on purpose: the logic can be tested with plain node.
export class CombinedMotion {
    private active = new Map<string, ReturnType<typeof setTimeout> | undefined>();

    constructor(private onChange: (motion: boolean) => void) {
    }

    get motion(): boolean {
        return this.active.size > 0;
    }

    get topics(): string[] {
        return [...this.active.keys()];
    }

    // resetMs <= 0: stays active until this topic reports false.
    set(topic: string, on: boolean, resetMs = 0) {
        const before = this.motion;
        clearTimeout(this.active.get(topic));
        if (on) {
            const timer = resetMs > 0 ? setTimeout(() => this.set(topic, false), resetMs) : undefined;
            this.active.set(topic, timer);
        }
        else {
            this.active.delete(topic);
        }
        if (this.motion !== before)
            this.onChange(this.motion);
    }

    // Forget all topics (settings changed, reconnect, release). Reports "no motion" if there was some.
    clear() {
        const before = this.motion;
        for (const timer of this.active.values())
            clearTimeout(timer);
        this.active.clear();
        if (before)
            this.onChange(false);
    }
}
