/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, expect } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { OpenCloudTrigger } from '../OpenCloudTrigger.node';
import { makePollFunctions, fixtures, nock, isolateNetwork, mockOnly } from '../../OpenCloud/__tests__/helpers';

// English activity templates (the node requests Accept-Language: en).
const ADDED = '{user} added {resource} to {folder}';
const UPDATED = '{user} updated {resource} in {folder}';
const SPACE = fixtures.MOCK_DRIVE;

function activity(id: string, message: string, recordedTime: string, name = 'file.txt'): IDataObject {
	return {
		id,
		times: { recordedTime },
		template: {
			message,
			variables: { resource: { name }, folder: { name: 'TestSpace' }, user: { displayName: 'Tester' } },
		},
	};
}

function nockActivities(items: IDataObject[]): void {
	nock(fixtures.TEST_SERVER)
		.get('/graph/v1beta1/extensions/org.libregraph/activities')
		.query(true)
		.reply(200, { value: items });
}

const node = new OpenCloudTrigger();

async function poll(staticData: IDataObject, parameters: Record<string, unknown>, mode?: 'manual' | 'trigger') {
	const { fns } = makePollFunctions({ parameters: { spaceId: SPACE, events: [], ...parameters }, mode, staticData });
	const result = (await node.poll.call(fns as never)) as Array<Array<{ json: IDataObject }>> | null;
	return result ? result[0].map((i) => i.json) : null;
}

describe('OpenCloudTrigger.poll', () => {
	isolateNetwork();

	mockOnly.it('first scheduled poll baselines and emits nothing', async () => {
		const staticData: IDataObject = {};
		nockActivities([activity('a', ADDED, '2026-01-01T00:00:00Z'), activity('b', ADDED, '2026-01-01T00:00:01Z')]);
		const items = await poll(staticData, {});
		expect(items).toBeNull();
		expect(staticData.seenIds).toEqual(['a', 'b']);
	});

	mockOnly.it('emits only activities not seen before', async () => {
		const staticData: IDataObject = { seenIds: ['a', 'b'] };
		nockActivities([
			activity('a', ADDED, '2026-01-01T00:00:00Z'),
			activity('b', ADDED, '2026-01-01T00:00:01Z'),
			activity('c', ADDED, '2026-01-01T00:00:02Z', 'new.txt'),
		]);
		const items = await poll(staticData, {});
		expect(items?.map((i) => i.id)).toEqual(['c']);
		expect((staticData.seenIds as string[]).slice().sort()).toEqual(['a', 'b', 'c']);
	});

	mockOnly.it('emits BOTH activities sharing one recordedTime (id-based dedup, the fix)', async () => {
		const staticData: IDataObject = { seenIds: ['a'] };
		const t = '2026-01-01T00:00:05.000Z';
		nockActivities([
			activity('a', ADDED, '2026-01-01T00:00:00Z'),
			activity('x', ADDED, t, 'x.txt'),
			activity('y', ADDED, t, 'y.txt'),
		]);
		const items = await poll(staticData, {});
		// A `recordedTime > last` window would drop one of x/y; id-based keeps both.
		expect(items?.map((i) => i.id).sort()).toEqual(['x', 'y']);
	});

	mockOnly.it('filters by event type but still marks all fetched ids seen', async () => {
		const staticData: IDataObject = { seenIds: [] };
		nockActivities([activity('u1', UPDATED, '2026-01-01T00:00:00Z'), activity('a1', ADDED, '2026-01-01T00:00:01Z', 'added.txt')]);
		const items = await poll(staticData, { events: ['fileAdded'] });
		expect(items?.map((i) => i.id)).toEqual(['a1']);
		expect(items?.[0].event).toBe('fileAdded');
		expect((staticData.seenIds as string[]).slice().sort()).toEqual(['a1', 'u1']);
	});

	mockOnly.it('does not re-emit when nothing new arrived', async () => {
		const staticData: IDataObject = { seenIds: ['a', 'b'] };
		nockActivities([activity('a', ADDED, '2026-01-01T00:00:00Z'), activity('b', ADDED, '2026-01-01T00:00:01Z')]);
		expect(await poll(staticData, {})).toBeNull();
	});

	mockOnly.it('manual mode returns matching activities regardless of seen state', async () => {
		const staticData: IDataObject = { seenIds: ['a', 'b'] };
		nockActivities([activity('a', ADDED, '2026-01-01T00:00:00Z'), activity('b', ADDED, '2026-01-01T00:00:01Z')]);
		const items = await poll(staticData, {}, 'manual');
		expect(items?.map((i) => i.id).sort()).toEqual(['a', 'b']);
	});
});
