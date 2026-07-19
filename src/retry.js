class RetryController {
	constructor({
		initialDelayMs = 30_000,
		maxDelayMs = 1_800_000,
		setTimeoutFn = setTimeout,
		clearTimeoutFn = clearTimeout,
	} = {}) {
		this.initialDelayMs = initialDelayMs;
		this.maxDelayMs = maxDelayMs;
		this.nextDelayMs = initialDelayMs;
		this.setTimeoutFn = setTimeoutFn;
		this.clearTimeoutFn = clearTimeoutFn;
		this.timer = null;
	}

	get pending() {
		return this.timer !== null;
	}

	schedule(callback) {
		if (this.pending) return null;

		const delay = this.nextDelayMs;
		this.timer = this.setTimeoutFn(() => {
		this.timer = null;
		this.nextDelayMs = Math.min(delay * 2, this.maxDelayMs);
		callback();
		}, delay);
		return delay;
	}

	reset() {
		this.cancel();
		this.nextDelayMs = this.initialDelayMs;
	}

	cancel() {
		if (this.timer !== null) this.clearTimeoutFn(this.timer);
		this.timer = null;
	}
}


export { RetryController };