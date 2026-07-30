import {
	IHookFunctions,
	IWebhookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	NodeApiError,
	NodeConnectionTypes,
	IDataObject,
	IHttpRequestMethods,
} from 'n8n-workflow';
import type { ILoadOptionsFunctions, INodePropertyOptions, JsonObject } from 'n8n-workflow';

// AgentMail nests each event's object under a key named after the event, not under a shared
// envelope key. This covers AgentMail's full event enum, not just the four the Event dropdown
// offers: the dropdown is an `options` parameter, so an expression can set `event` to any valid
// event type, and create() will happily register it. An event missing from this map would fire
// the workflow with every flattened field undefined.
export const EVENT_PAYLOAD_KEY: Record<string, string> = {
	'message.received': 'message',
	'message.received.spam': 'message',
	'message.received.blocked': 'message',
	'message.received.unauthenticated': 'message',
	'message.sent': 'send',
	'message.delivered': 'delivery',
	'message.bounced': 'bounce',
	'message.complained': 'complaint',
	'message.rejected': 'reject',
	'message.opened': 'open',
	'domain.verified': 'domain',
};

export class AgentMailTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AgentMail Trigger',
		name: 'agentMailTrigger',
		icon: 'file:agentmail.svg',
		iconColor: 'black',
		group: ['trigger'],
		version: 1,
		subtitle: '=Listens for {{$parameter["event"]}}',
		description: 'Triggers when an email event occurs (received, sent, etc.)',
		defaults: {
			name: 'AgentMail Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'agentMailApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		triggerPanel: {
			header: 'Listen for AgentMail Events',
			executionsHelp: {
				inactive: 'Activate the workflow to start listening for emails. AgentMail will send events to this node whenever an email is received, sent, delivered, or bounced.',
				active: 'Your workflow is listening for emails. Send an email to one of your AgentMail inboxes to trigger it.',
			},
			activationHint: 'Activate the workflow to start receiving emails in real time.',
		},
		activationMessage: 'Your workflow is now listening for AgentMail email events.',
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: [
					{
						name: 'Email Bounced',
						value: 'message.bounced',
						description: 'Triggers when an email bounces',
					},
					{
						name: 'Email Delivered',
						value: 'message.delivered',
						description: 'Triggers when an email is delivered',
					},
					{
						name: 'Email Received',
						value: 'message.received',
						description: 'Triggers when an email is received in any inbox',
					},
					{
						name: 'Email Sent',
						value: 'message.sent',
						description: 'Triggers when an email is sent',
					},
				],
				default: 'message.received',
				required: true,
				description: 'The event to listen for',
			},
			{
				displayName: 'Inbox Filter Name or ID',
				name: 'inboxFilter',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getInboxes',
				},
				default: '',
				description: 'Only trigger for this specific inbox (leave empty for all inboxes). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getInboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'agentMailApi',
					{
						method: 'GET' as IHttpRequestMethods,
						url: 'https://api.agentmail.to/v0/inboxes',
						qs: { limit: 100 },
						json: true,
					},
				) as IDataObject;

				const inboxes = (response.inboxes || []) as IDataObject[];
				const options: INodePropertyOptions[] = [
					{ name: 'All Inboxes', value: '' },
				];
				for (const inbox of inboxes) {
					options.push({
						name: (inbox.email as string) || `${inbox.username}@${inbox.domain || 'agentmail.to'}`,
						value: (inbox.inbox_id || inbox.id) as string,
					});
				}
				return options;
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const webhookData = this.getWorkflowStaticData('node');
				const event = this.getNodeParameter('event') as string;
				const baseUrl = 'https://api.agentmail.to/v0';

				// A webhook "existing" is not enough — it must also be subscribed to the currently
				// configured event. Otherwise, changing the Event dropdown (without a full
				// deactivate/reactivate) leaves AgentMail delivering the OLD event_types: the call
				// succeeds (200), but webhook()'s eventType check silently drops every delivery since
				// it no longer matches the current parameter. Treat an event_types mismatch as "does
				// not exist" so n8n re-runs create() with the right subscription.
				const eventTypesMatch = (webhook: IDataObject): boolean => {
					const eventTypes = (webhook.event_types || webhook.eventTypes || []) as string[];
					return eventTypes.includes(event);
				};

				// Check if we have a stored webhook ID
				if (webhookData.webhookId) {
					try {
						// Verify it still exists AND is still subscribed to the current event
						const webhook = await this.helpers.httpRequestWithAuthentication.call(
							this,
							'agentMailApi',
							{
								method: 'GET' as IHttpRequestMethods,
								url: `${baseUrl}/webhooks/${webhookData.webhookId}`,
								json: true,
							},
						) as IDataObject;

						if (!eventTypesMatch(webhook)) {
							delete webhookData.webhookId;
							return false;
						}
						return true;
					} catch {
						// Webhook no longer exists
						delete webhookData.webhookId;
						return false;
					}
				}

				// Check if any webhook matches our URL and is subscribed to the current event.
				// If listing fails (auth error, transient API issue), surface it instead of silently
				// returning false — that would cause n8n to call create() and register a duplicate.
				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'agentMailApi',
					{
						method: 'GET' as IHttpRequestMethods,
						url: `${baseUrl}/webhooks`,
						json: true,
					},
				) as IDataObject;

				const webhooks = (response.webhooks || response.data || []) as IDataObject[];
				for (const webhook of webhooks) {
					if (webhook.url === webhookUrl && eventTypesMatch(webhook)) {
						webhookData.webhookId = webhook.webhook_id || webhook.id;
						return true;
					}
				}

				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const event = this.getNodeParameter('event') as string;
				const webhookData = this.getWorkflowStaticData('node');
				const baseUrl = 'https://api.agentmail.to/v0';

				let response: IDataObject;
				try {
					// If a webhook already exists for this URL (e.g. the Event dropdown changed and
					// checkExists() correctly flagged the event_types mismatch), PATCH it to the
					// current event instead of POSTing a new one — otherwise every event change leaves
					// an orphaned, still-active registration behind on AgentMail's side.
					const existing = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'agentMailApi',
						{
							method: 'GET' as IHttpRequestMethods,
							url: `${baseUrl}/webhooks`,
							json: true,
						},
					) as IDataObject;
					const webhooks = (existing.webhooks || existing.data || []) as IDataObject[];
					const match = webhooks.find((webhook) => webhook.url === webhookUrl);

					if (match) {
						const matchId = match.webhook_id || match.id;
						response = await this.helpers.httpRequestWithAuthentication.call(
							this,
							'agentMailApi',
							{
								method: 'PATCH' as IHttpRequestMethods,
								url: `${baseUrl}/webhooks/${matchId}`,
								body: {
									event_types: [event],
								},
								json: true,
							},
						) as IDataObject;
						webhookData.webhookId = response.webhook_id || response.id || matchId;
						return true;
					}

					response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'agentMailApi',
						{
							method: 'POST' as IHttpRequestMethods,
							url: `${baseUrl}/webhooks`,
							body: {
								url: webhookUrl,
								event_types: [event],
							},
							json: true,
						},
					) as IDataObject;
				} catch (error) {
					throw new NodeApiError(this.getNode(), error as JsonObject, {
						message: 'Failed to register AgentMail webhook',
						description: 'Check that your API key is valid and your AgentMail plan allows webhooks.',
					});
				}

				webhookData.webhookId = response.webhook_id || response.id || (response.webhook as IDataObject)?.id;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const baseUrl = 'https://api.agentmail.to/v0';

				if (!webhookData.webhookId) {
					return true;
				}

				try {
					await this.helpers.httpRequestWithAuthentication.call(
						this,
						'agentMailApi',
						{
							method: 'DELETE' as IHttpRequestMethods,
							url: `${baseUrl}/webhooks/${webhookData.webhookId}`,
							json: true,
						},
					);
				} catch {
					// Ignore errors on delete
				}

				delete webhookData.webhookId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData() as IDataObject;
		const event = this.getNodeParameter('event') as string;
		const inboxFilter = this.getNodeParameter('inboxFilter') as string;

		// AgentMail's envelope sets `type` to the literal string "event" on every delivery and
		// carries the event name in `event_type`. Matching on `type` therefore never matches.
		const eventType = body.event_type;
		if (eventType !== event) {
			// Not the subscribed event: ACK and start no workflow. An empty response makes n8n
			// reply 200; `noWebhookResponse` would send nothing at all and hang the delivery
			// until the sender times out, which AgentMail's Svix retries and eventually
			// counts toward disabling the endpoint.
			return {};
		}

		// Each event nests its object under its own key — there is no shared `data` key.
		const messageData = (body[EVENT_PAYLOAD_KEY[event]] || {}) as IDataObject;

		// Filter by inbox if specified. inbox_id is the inbox's email address, which is what
		// the Inbox Filter dropdown stores as its option value.
		if (inboxFilter) {
			if (messageData.inbox_id !== inboxFilter) {
				return {};
			}
		}

		// Return formatted data
		return {
			workflowData: [
				this.helpers.returnJsonArray({
					event: eventType,
					eventId: body.event_id,
					// The envelope carries no top-level timestamp; it lives on the event object.
					timestamp: messageData.timestamp,
					// Message details. AgentMail's payloads are snake_case throughout, so there is
					// no camelCase form to fall back to. Fields absent from a given event's object
					// (a send carries no subject, for example) come through undefined; rawPayload
					// below always has the whole body.
					messageId: messageData.message_id,
					inboxId: messageData.inbox_id,
					threadId: messageData.thread_id,
					from: messageData.from,
					to: messageData.to,
					subject: messageData.subject,
					text: messageData.text,
					html: messageData.html,
					// Bodies over ~64KB are not inlined: text/html are omitted and a signed URL is
					// sent instead, so surface it rather than leaving the body silently empty.
					bodyUrl: messageData.body_url,
					// Labels and metadata
					labels: messageData.labels,
					attachments: messageData.attachments,
					// Raw payload for advanced use
					rawPayload: body,
				}),
			],
		};

	}
}
