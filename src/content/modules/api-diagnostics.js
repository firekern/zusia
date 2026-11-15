"use strict";

Object.assign(Zusia, {
	apiDiagnostic(error) {
		let message = String(error?.message || error || "API request failed.");
		let status = error?.status || Number(message.match(/API HTTP (\d+)/)?.[1]);
		let code = error?.code;
		if (!code) {
			if (status === 401 || status === 403 || /enter an API key|OS key store/i.test(message)) code = "auth";
			else if (/out of memory|insufficient.*memory|CUDA.*memory|not enough.*(VRAM|memory)|allocation.*fail/i.test(message)) code = "memory";
			else if (/context.*(limit|budget|window|full)|exceed.*context/i.test(message)) code = "context";
			else if (/model.*changed|changed.*model/i.test(message)) code = "model_changed";
			else if (/ended before|interrupted.*response|incomplete.*(stream|answer)/i.test(message)) code = "incomplete";
			else if (status === 404 || /model.*(not found|not available|unavailable)|choose.*model ID|did not load.*model/i.test(message)) code = "model";
			else if (/connection interrupted|server.*(unreachable|not running)|timed out/i.test(message)) code = "connection";
			else if (status === 429) code = "rate_limit";
			else code = "request";
		}
		let descriptions = {
			auth: ["API authentication needs attention", "Check the saved key and endpoint in Assistants settings.", "settings", "Check authentication"],
			memory: ["The model needs more memory", "Use a smaller quantization or reduce context/parallel slots in the provider profile, then load again.", "settings", "Review model profile"],
			context: ["The context budget is full", "Reduce the question or output budget, or increase the model's effective context.", "settings", "Review context settings"],
			model: ["Choose an available model", "Check the exact model ID and make sure it is downloaded on this server.", "settings", "Choose model"],
			model_changed: ["The provider changed models", "The selected model no longer matches the running tokenizer. Check the selection before retrying.", "settings", "Check model"],
			incomplete: ["The answer was interrupted", "Any partial answer is incomplete. Check the server, then retry when ready.", "retry", "Retry question"],
			connection: ["The API server is unreachable", "Start the server and check its URL and network connection, then retry.", "retry", "Retry connection"],
			rate_limit: ["The provider is busy", "Wait for the provider's limit to clear, then retry.", "retry", "Try again"],
			request: ["The API could not answer", "Check the provider's model settings and the details below.", "settings", "Open Assistants settings"],
		};
		let [title, help, action, actionLabel] = descriptions[code] || descriptions.request;
		return { code, title, message, help, action, actionLabel };
	},

	apiFailure(code, message) {
		let error = new Error(message);
		error.code = code;
		return error;
	},
});
