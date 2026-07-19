const DISCORD_WEBHOOK_CONTENT = 'Steam Idler needs authentication renewal. Run the enrollment command, then start the service.';

function createAuthenticationNotifier({ webhookUrl, fetchFn = fetch } = {}) {
	if (webhookUrl === undefined) return undefined;

	return async function notifyAuthenticationRequired() {
		const response = await fetchFn(webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ content: DISCORD_WEBHOOK_CONTENT }),
		});
		if (!response.ok) {
			throw new Error(`Discord webhook request failed with status ${response.status}`);
		}
	};
}

export { createAuthenticationNotifier, DISCORD_WEBHOOK_CONTENT };
