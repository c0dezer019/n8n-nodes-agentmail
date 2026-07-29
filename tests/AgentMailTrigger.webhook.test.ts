import { AgentMailTrigger, EVENT_PAYLOAD_KEY } from '../nodes/AgentMail/AgentMailTrigger.node';
import { createMockWebhookFunctions } from './helpers';

describe('AgentMailTrigger webhook handler', () => {
	const node = new AgentMailTrigger();

	// Mirrors AgentMail's real delivery envelope: `type` is the constant "event", the event name
	// lives in `event_type`, and each event nests its object under its own key (received ->
	// message, sent -> send). Do not reshape this without checking the API's createEventPayload.
	const buildReceived = (overrides: any = {}) => ({
		type: 'event',
		event_type: 'message.received',
		event_id: 'evt_123',
		message: {
			message_id: 'msg_456',
			inbox_id: 'agent@agentmail.to',
			thread_id: 'thread_012',
			from: 'sender@example.com',
			to: ['agent@agentmail.to'],
			subject: 'Hello',
			text: 'Plain text',
			html: '<p>HTML</p>',
			labels: ['received'],
			attachments: [],
			timestamp: '2026-04-13T10:00:00Z',
			...overrides.message,
		},
		thread: { thread_id: 'thread_012' },
		...overrides,
	});

	const buildSent = (overrides: any = {}) => ({
		type: 'event',
		event_type: 'message.sent',
		event_id: 'evt_sent_1',
		send: {
			organization_id: 'org_1',
			pod_id: 'pod_1',
			inbox_id: 'agent@agentmail.to',
			thread_id: 'thread_012',
			message_id: 'msg_sent_1',
			timestamp: '2026-04-13T11:00:00Z',
			recipients: ['dest@example.com'],
			...overrides.send,
		},
		...overrides,
	});

	describe('event filtering', () => {
		it('fires for a real envelope where type is "event" and event_type is the event name', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived(),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
			expect(result.workflowData![0][0].json.event).toBe('message.received');
		});

		it('does not treat the constant type:"event" as the event name', async () => {
			// Regression guard: reading body.type yielded "event", which never equals a
			// subscribed event, so every delivery was silently dropped.
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived(),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
			expect(result.workflowData![0][0].json.event).not.toBe('event');
		});

		it('does NOT fire when event_type is a different event', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildSent(),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeUndefined();
		});

		it('ACKs an unsubscribed event with an empty response instead of hanging the sender', async () => {
			// `noWebhookResponse: true` tells n8n the node already wrote the response; it hadn't,
			// so the delivery hung until the sender timed out. An empty object makes n8n reply 200.
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildSent(),
			);

			const result = await node.webhook.call(ctx);

			expect(result).toEqual({});
			expect(result.noWebhookResponse).toBeUndefined();
		});

		it('does not fire for a received sub-variant such as message.received.spam', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived({ event_type: 'message.received.spam' }),
			);

			const result = await node.webhook.call(ctx);

			expect(result).toEqual({});
		});
	});

	describe('inbox filter', () => {
		it('fires when inboxFilter is empty (all inboxes)', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived({ message: { inbox_id: 'anything@agentmail.to' } }),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
		});

		it('matches message.inbox_id, which is the inbox email address', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: 'agent@agentmail.to' },
				buildReceived({ message: { inbox_id: 'agent@agentmail.to' } }),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
		});

		it('does NOT fire when inbox_id does not match the filter', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: 'agent@agentmail.to' },
				buildReceived({ message: { inbox_id: 'other@agentmail.to' } }),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeUndefined();
		});

		it('ACKs an inbox-filter miss with an empty response instead of hanging', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: 'agent@agentmail.to' },
				buildReceived({ message: { inbox_id: 'other@agentmail.to' } }),
			);

			const result = await node.webhook.call(ctx);

			expect(result).toEqual({});
		});

		it('filters message.sent on send.inbox_id', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.sent', inboxFilter: 'agent@agentmail.to' },
				buildSent({ send: { inbox_id: 'agent@agentmail.to' } }),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
		});
	});

	describe('output data shape', () => {
		it('flattens the received message from the "message" key', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived(),
			);

			const result = await node.webhook.call(ctx);
			const output = result.workflowData![0][0].json;

			expect(output).toMatchObject({
				event: 'message.received',
				eventId: 'evt_123',
				timestamp: '2026-04-13T10:00:00Z',
				messageId: 'msg_456',
				inboxId: 'agent@agentmail.to',
				threadId: 'thread_012',
				from: 'sender@example.com',
				to: ['agent@agentmail.to'],
				subject: 'Hello',
				text: 'Plain text',
				html: '<p>HTML</p>',
				labels: ['received'],
				attachments: [],
			});
		});

		it('resolves message.sent from the "send" key, not "message"', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.sent', inboxFilter: '' },
				buildSent(),
			);

			const result = await node.webhook.call(ctx);
			const output = result.workflowData![0][0].json;

			expect(output).toMatchObject({
				event: 'message.sent',
				eventId: 'evt_sent_1',
				messageId: 'msg_sent_1',
				inboxId: 'agent@agentmail.to',
				threadId: 'thread_012',
				timestamp: '2026-04-13T11:00:00Z',
			});
		});

		it('takes timestamp from the event object, not the envelope', async () => {
			// The envelope carries no top-level timestamp, so reading body.timestamp
			// always produced undefined.
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived({ message: { timestamp: '2026-05-01T00:00:00Z' } }),
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData![0][0].json.timestamp).toBe('2026-05-01T00:00:00Z');
		});

		it('includes the raw payload for advanced use cases', async () => {
			const event = buildReceived();
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				event,
			);

			const result = await node.webhook.call(ctx);
			const output = result.workflowData![0][0].json as any;

			expect(output.rawPayload).toEqual(event);
		});

		it('surfaces body_url when a large body is not inlined', async () => {
			// Bodies over ~64KB arrive with text/html omitted and a signed body_url instead.
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				buildReceived({
					message: {
						text: undefined,
						html: undefined,
						body_url: 'https://example.com/signed',
						body_expires_at: '2026-04-13T11:00:00Z',
					},
				}),
			);

			const result = await node.webhook.call(ctx);
			const output = result.workflowData![0][0].json as any;

			expect(output.text).toBeUndefined();
			expect(output.bodyUrl).toBe('https://example.com/signed');
		});

		it('handles a missing event object gracefully', async () => {
			const ctx = createMockWebhookFunctions(
				{ event: 'message.received', inboxFilter: '' },
				{ type: 'event', event_type: 'message.received', event_id: 'evt_1' },
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
			expect(result.workflowData![0][0].json.event).toBe('message.received');
		});
	});

	describe('event payload key map', () => {
		it('has an entry for every event the Event dropdown offers', () => {
			// Drift guard: adding a dropdown option without a map entry would make the trigger
			// fire with every flattened field empty, and silently drop any inbox-filtered
			// delivery. TypeScript cannot catch it — indexing Record<string, string> yields
			// `string`, not `string | undefined`.
			const eventParam = node.description.properties.find((p) => p.name === 'event');
			const offered = (eventParam!.options as Array<{ value: string }>).map((o) => o.value);

			expect(offered.length).toBeGreaterThan(0);
			for (const value of offered) {
				expect(EVENT_PAYLOAD_KEY[value]).toBeDefined();
			}
		});

		// The Event dropdown offers four events, but it is an `options` parameter, so an
		// expression can set `event` to any valid AgentMail event type and create() will
		// register it. Every event in the API's enum must resolve its object, otherwise the
		// workflow fires with all fields empty and an inbox filter drops every delivery.
		const cases: Array<[string, string, Record<string, unknown>]> = [
			['message.received.spam', 'message', { inbox_id: 'a@agentmail.to', message_id: 'm1' }],
			['message.delivered', 'delivery', { inbox_id: 'a@agentmail.to', message_id: 'm2' }],
			['message.bounced', 'bounce', { inbox_id: 'a@agentmail.to', message_id: 'm3' }],
			['message.complained', 'complaint', { inbox_id: 'a@agentmail.to', message_id: 'm4' }],
			['message.rejected', 'reject', { inbox_id: 'a@agentmail.to', message_id: 'm5' }],
			['message.opened', 'open', { inbox_id: 'a@agentmail.to', message_id: 'm6' }],
		];

		it.each(cases)('resolves %s from the "%s" key', async (eventType, key, obj) => {
			const ctx = createMockWebhookFunctions(
				{ event: eventType, inboxFilter: '' },
				{ type: 'event', event_type: eventType, event_id: 'evt_x', [key]: obj },
			);

			const result = await node.webhook.call(ctx);
			const output = result.workflowData![0][0].json;

			expect(output.inboxId).toBe('a@agentmail.to');
			expect(output.messageId).toBe(obj.message_id);
		});

		it.each(cases)('applies the inbox filter to %s', async (eventType, key) => {
			const ctx = createMockWebhookFunctions(
				{ event: eventType, inboxFilter: 'wanted@agentmail.to' },
				{
					type: 'event',
					event_type: eventType,
					event_id: 'evt_x',
					[key]: { inbox_id: 'wanted@agentmail.to', message_id: 'm' },
				},
			);

			const result = await node.webhook.call(ctx);

			expect(result.workflowData).toBeDefined();
		});
	});
});
