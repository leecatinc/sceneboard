'use client';

import {
  AccessManagementListParserV1,
  BoardErrorParserV1,
  BoardIdParserV1,
  BoardInvitationEnvelopeParserV1,
  GlobalIdStringParserV1,
  InvitationAcceptanceParserV1,
  ManagedMembershipEnvelopeParserV1,
  MemberCandidateListParserV1,
  PrincipalIdParserV1,
  type BoardInvitationEnvelopeV1,
  type AccessManagementListV1,
  type InvitationAcceptanceV1,
  type InvitationRoleV1,
  type ManagedMembershipEnvelopeV1,
  type MemberCandidateListV1,
} from '@sceneboard/board-schema';

import type { SessionRequestCoordinator } from '../auth/renewal-singleflight';
import { exactKeys, isObject } from './board-api-core';
import type { ApiResult } from './board-api-types';

type Parser<Value> = {
  parse(input: unknown): { ok: true; data: { value: Value } } | { ok: false };
};

export class InvitationApi {
  constructor(private readonly coordinator: SessionRequestCoordinator) {}

  async list(
    boardIdValue: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<AccessManagementListV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/members`,
      'GET',
      undefined,
      AccessManagementListParserV1,
      200,
      signal,
    );
  }

  async search(
    boardIdValue: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<MemberCandidateListV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    const params = new URLSearchParams({ q: query });
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/member-candidates?${params.toString()}`,
      'GET',
      undefined,
      MemberCandidateListParserV1,
      200,
      signal,
    );
  }

  async issue(
    boardIdValue: string,
    target: { email: string } | { accountId: string },
    role: InvitationRoleV1,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardInvitationEnvelopeV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    const body =
      'email' in target
        ? { email: target.email, role }
        : { accountId: parse(PrincipalIdParserV1, target.accountId), role };
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/invitations`,
      'POST',
      body,
      BoardInvitationEnvelopeParserV1,
      201,
      signal,
    );
  }

  async resend(
    boardIdValue: string,
    inviteIdValue: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<BoardInvitationEnvelopeV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    const inviteId = parse(GlobalIdStringParserV1, inviteIdValue);
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/invitations/${encodeURIComponent(inviteId)}/resend`,
      'POST',
      {},
      BoardInvitationEnvelopeParserV1,
      201,
      signal,
    );
  }

  async revoke(
    boardIdValue: string,
    inviteIdValue: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<null>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    const inviteId = parse(GlobalIdStringParserV1, inviteIdValue);
    return this.dispatchEmpty(
      `/api/v1/boards/${encodeURIComponent(boardId)}/invitations/${encodeURIComponent(inviteId)}`,
      signal,
    );
  }

  async accept(token: string, signal?: AbortSignal): Promise<ApiResult<InvitationAcceptanceV1>> {
    return this.dispatch(
      `/api/v1/invitations/${encodeURIComponent(token)}/accept`,
      'POST',
      {},
      InvitationAcceptanceParserV1,
      200,
      signal,
    );
  }

  async updateMember(
    boardIdValue: string,
    memberIdValue: string,
    role: InvitationRoleV1,
    version: number,
    signal?: AbortSignal,
  ): Promise<ApiResult<ManagedMembershipEnvelopeV1>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    const memberId = parse(GlobalIdStringParserV1, memberIdValue);
    return this.dispatch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(memberId)}`,
      'PATCH',
      { role, version },
      ManagedMembershipEnvelopeParserV1,
      200,
      signal,
    );
  }

  async removeMember(
    boardIdValue: string,
    memberIdValue: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<ApiResult<null>> {
    const boardId = parse(BoardIdParserV1, boardIdValue);
    const memberId = parse(GlobalIdStringParserV1, memberIdValue);
    const query = new URLSearchParams({ version: String(version) });
    return this.dispatchEmpty(
      `/api/v1/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(memberId)}?${query.toString()}`,
      signal,
    );
  }

  private async dispatch<Value>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body: unknown,
    parser: Parser<Value>,
    successStatus: number,
    signal?: AbortSignal,
  ): Promise<ApiResult<Value>> {
    const csrfToken = method === 'GET' ? undefined : this.coordinator.currentSnapshot()?.csrfToken;
    if (method !== 'GET' && csrfToken === undefined) return { kind: 'reconciliation_required' };
    const result = await this.coordinator.dispatchShared({
      path,
      method,
      ...(body === undefined ? {} : { body }),
      ...(csrfToken === undefined ? {} : { csrfToken }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    if (!result.value.response.ok)
      return decodeError(result.value.response.status, result.value.body);
    const parsed = parser.parse(result.value.body);
    if (result.value.response.status !== successStatus || !parsed.ok)
      return { kind: 'corrupt_response' };
    return { kind: 'ok', value: parsed.data.value };
  }

  private async dispatchEmpty(path: string, signal?: AbortSignal): Promise<ApiResult<null>> {
    const csrfToken = this.coordinator.currentSnapshot()?.csrfToken;
    if (csrfToken === undefined) return { kind: 'reconciliation_required' };
    const result = await this.coordinator.dispatchShared({
      path,
      method: 'DELETE',
      csrfToken,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind !== 'ok') return result;
    if (!result.value.response.ok)
      return decodeError(result.value.response.status, result.value.body);
    return result.value.response.status === 204
      ? { kind: 'ok', value: null }
      : { kind: 'corrupt_response' };
  }
}

const parse = <Value>(parser: Parser<Value>, value: unknown): Value => {
  const parsed = parser.parse(value);
  if (!parsed.ok) throw new TypeError('invalid invitation API identifier');
  return parsed.data.value;
};

const decodeError = (status: number, body: unknown): ApiResult<never> => {
  if (isObject(body) && exactKeys(body, ['error'])) {
    const parsed = BoardErrorParserV1.parse(body.error);
    if (parsed.ok && parsed.data.value.httpStatusHint === status)
      return { kind: 'board_error', error: parsed.data.value };
  }
  return { kind: 'api_error', status };
};
