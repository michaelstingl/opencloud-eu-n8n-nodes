/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, expect } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { OpenCloud } from '../OpenCloud.node';
import { makeExecuteFunctions, fixtures, nock, isolateNetwork, mockOnly } from './helpers';

const node = new OpenCloud();

describe('OpenCloud space:listMembers', () => {
	isolateNetwork();

	mockOnly.it('lists user and group grantees with their roles (single call, no email resolve)', async () => {
		const scope = nock(fixtures.TEST_SERVER)
			.get(/\/root\/permissions$/)
			.reply(200, {
				value: [
					{ grantedToV2: { user: { id: 'u1', displayName: 'Alice' } }, roles: ['role-viewer'] },
					{ grantedToV2: { group: { id: 'g1', displayName: 'team' } }, roles: ['role-editor'] },
				],
			});

		const { fns } = makeExecuteFunctions({
			parameters: { resource: 'space', operation: 'listMembers', spaceId: fixtures.MOCK_DRIVE },
		});
		const result = (await node.execute.call(fns as never)) as Array<Array<{ json: IDataObject }>>;
		const members = result[0].map((i) => i.json);

		expect(members).toHaveLength(2);
		expect(members.find((m) => m.id === 'u1')).toMatchObject({
			type: 'user',
			displayName: 'Alice',
			roles: ['role-viewer'],
		});
		expect(members.find((m) => m.id === 'g1')).toMatchObject({
			type: 'group',
			displayName: 'team',
			roles: ['role-editor'],
		});
		// One call only: the operation does not fan out to /users/{id} for email.
		expect(scope.isDone()).toBe(true);
	});
});
