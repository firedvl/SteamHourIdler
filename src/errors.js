class OperatorActionRequiredError extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = 'OperatorActionRequiredError';
	}
}

export { OperatorActionRequiredError };
