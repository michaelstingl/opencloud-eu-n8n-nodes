import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { openCloudApiRequest } from '../OpenCloud/GenericFunctions';

// Activity-type catalogue. The activitylog API returns a localized
// `template.message` (the OpenCloud instance locale, e.g. German), so we always
// request with `Accept-Language: en` and match the English template strings,
// which are stable across instances. Source of truth for these strings:
// opencloud services/activitylog/pkg/service/response.go (MessageResource*).
const ACTIVITY_TYPES: ReadonlyArray<{ key: string; name: string; message: string }> = [
	{ key: 'fileAdded', name: 'File or folder added', message: '{user} added {resource} to {folder}' },
	{ key: 'fileUpdated', name: 'File or folder updated', message: '{user} updated {resource} in {folder}' },
	{ key: 'fileDeleted', name: 'File or folder deleted', message: '{user} deleted {resource} from {folder}' },
	{ key: 'itemMoved', name: 'Item moved', message: '{user} moved {resource} to {folder}' },
	{ key: 'itemRenamed', name: 'Item renamed', message: '{user} renamed {oldResource} to {resource}' },
	{ key: 'shareCreated', name: 'Share created', message: '{user} shared {resource} with {sharee}' },
	{ key: 'linkCreated', name: 'Link created', message: '{user} shared {resource} via link' },
	{ key: 'spaceShared', name: 'Member added to space', message: '{user} added {sharee} as member of {space}' },
];

const MESSAGE_TO_EVENT = new Map(ACTIVITY_TYPES.map((t) => [t.message, t.key]));

interface Activity {
	id?: string;
	times?: { recordedTime?: string };
	template?: { message?: string; variables?: IDataObject };
}

interface ActivitiesResponse {
	value?: Activity[];
}

export class OpenCloudTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OpenCloud Trigger',
		name: 'openCloudTrigger',
		icon: 'file:opencloud.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=On space activity: {{$parameter["spaceId"]}}',
		description: 'Starts the workflow when activity happens in an OpenCloud space (uploads, edits, shares, ...)',
		defaults: {
			name: 'OpenCloud Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'openCloudApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Space ID',
				name: 'spaceId',
				type: 'string',
				default: '',
				required: true,
				placeholder: '6075b3aa-...$7cb63fc5-...',
				description: 'The space root ID, used as the KQL itemid. For a project space this equals the drive ID, of the form storageId$spaceId. One trigger watches one space.',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: [],
				description: 'Which activity types to emit. Leave empty to emit every activity.',
				options: ACTIVITY_TYPES.map((t) => ({ name: t.name, value: t.key })),
			},
		],
		usableAsTool: true,
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const spaceId = (this.getNodeParameter('spaceId') as string).trim();
		const events = this.getNodeParameter('events', []) as string[];
		const isManual = this.getMode() === 'manual';

		// `kql` carries the filter; the id value MUST be quoted because the literal
		// `$` in {storageId}${spaceId} otherwise breaks the KQL tokenizer.
		const kql = encodeURIComponent(`itemid:"${spaceId}"`);
		const response = (await openCloudApiRequest.call(
			this,
			'GET',
			`/graph/v1beta1/extensions/org.libregraph/activities?kql=${kql}`,
			'',
			{ 'Accept-Language': 'en' },
			true,
		)) as ActivitiesResponse;

		const activities = (response.value ?? [])
			.filter((a) => a.times?.recordedTime)
			.sort((a, b) => (a.times!.recordedTime! < b.times!.recordedTime! ? -1 : 1));

		const decorate = (a: Activity): IDataObject => ({
			event: MESSAGE_TO_EVENT.get(a.template?.message ?? '') ?? 'other',
			recordedTime: a.times?.recordedTime,
			id: a.id,
			message: a.template?.message,
			variables: a.template?.variables,
		});

		const matches = (a: Activity): boolean => {
			if (events.length === 0) return true;
			return events.includes(MESSAGE_TO_EVENT.get(a.template?.message ?? '') ?? 'other');
		};

		// Manual test run: return the matching activities so the user sees data,
		// without advancing the dedup baseline.
		if (isManual) {
			const items = activities.filter(matches).map(decorate);
			return items.length ? [this.helpers.returnJsonArray(items)] : null;
		}

		const staticData = this.getWorkflowStaticData('node');
		const lastRecordedTime = staticData.lastRecordedTime as string | undefined;
		const newest = activities.length ? activities[activities.length - 1].times!.recordedTime! : undefined;

		// First scheduled poll after activation: set the baseline and emit nothing,
		// so activation does not replay the whole history.
		if (lastRecordedTime === undefined) {
			if (newest) staticData.lastRecordedTime = newest;
			return null;
		}

		const fresh = activities
			.filter((a) => a.times!.recordedTime! > lastRecordedTime)
			.filter(matches)
			.map(decorate);

		if (newest && newest > lastRecordedTime) staticData.lastRecordedTime = newest;

		return fresh.length ? [this.helpers.returnJsonArray(fresh)] : null;
	}
}
