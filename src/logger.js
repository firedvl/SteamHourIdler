const SENSITIVE_KEY = /password|token|secret|authorization|cookie|guard.*code/i;
const JWT_VALUE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_VALUE = /Bearer\s+\S+/gi;

function redactString(value) {
  return value.replace(JWT_VALUE, '[REDACTED]').replace(BEARER_VALUE, '[REDACTED]');
}

function redact(value, seen = new WeakSet()) {
	if (typeof value === 'string') return redactString(value);
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[CIRCULAR]';
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => redact(item, seen));
	}

	if (value instanceof Error) {
		return {
		name: value.name,
		message: redactString(value.message),
		...(value.eresult === undefined ? {} : { eresult: value.eresult }),
		};
	}

	return Object.fromEntries(Object.entries(value).map(([key, item]) => [
		key,
		SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, seen),
	]));
}

function createLogger({
	stdout = process.stdout,
	stderr = process.stderr,
	now = () => new Date(),
} = {}) {
	function write(level, event, fields = {}) {
		const record = redact({
			timestamp: now().toISOString(),
			level,
			event,
			...fields,
		});
		const stream = level === 'error' ? stderr : stdout;
		stream.write(`${JSON.stringify(record)}\n`);
	}

	return {
		info: (event, fields) => write('info', event, fields),
		warn: (event, fields) => write('warn', event, fields),
		error: (event, fields) => write('error', event, fields),
	};
}

export { redact, createLogger };