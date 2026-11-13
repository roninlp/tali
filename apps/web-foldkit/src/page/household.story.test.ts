import { Option } from 'effect'
import {
  Command,
  expectNoOutMessage,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vite-plus/test'

import { InviteCode } from '@tali/domain'

import { HouseholdSummary } from '../household-summary'
import type { AuthFailure } from '../lib/auth-api'
import {
  CopyInviteCode,
  Message,
  OutMessage,
  SubmitCreateHousehold,
  SubmitJoinHousehold,
  initialModel,
  update,
} from './household'

const householdId = '0192f0a0-0000-7000-8000-000000000002'
const householdName = 'خانه‌ی ما'
const inviteCode = 'invite-code'

const alreadyInHousehold: AuthFailure = {
  code: 'AlreadyInHousehold',
  retryable: false,
}

describe('household create', () => {
  test('requires a household name', () => {
    story(
      update,
      given(
        modifyFields(initialModel(), {
          create: () =>
            modifyFields(initialModel().create, { name: () => '   ' }),
        }),
      ),
      message(Message.SubmittedCreateHousehold()),
      model(model => {
        expect(model.create.maybeError).toStrictEqual(
          Option.some('نام خانه را وارد کنید.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('creating a household shows the invite and tells the parent', () => {
    story(
      update,
      given(initialModel()),
      message(Message.SubmittedCreateHousehold()),
      model(model => {
        expect(model.create.isSubmitting).toBe(true)
      }),
      Command.expectExact(SubmitCreateHousehold({ name: 'خانه‌ی ما' })),
      Command.resolve(
        SubmitCreateHousehold,
        Message.SucceededCreateHousehold({
          household: HouseholdSummary.make({
            id: householdId,
            name: householdName,
            inviteCode,
          }),
        }),
      ),
      model(model => {
        expect(model.maybeCreated).toStrictEqual(
          Option.some(
            HouseholdSummary.make({
              id: householdId,
              name: householdName,
              inviteCode,
            }),
          ),
        )
      }),
      expectOutMessage(OutMessage.CreatedHousehold({ householdId })),
    )
  })

  test('AlreadyInHousehold resyncs instead of showing a form error', () => {
    story(
      update,
      given(initialModel()),
      message(Message.SubmittedCreateHousehold()),
      Command.resolve(
        SubmitCreateHousehold,
        Message.FailedCreateHousehold({ failure: alreadyInHousehold }),
      ),
      model(model => {
        expect(model.create.maybeError).toStrictEqual(Option.none())
        expect(model.create.isSubmitting).toBe(false)
      }),
      expectOutMessage(OutMessage.AlreadyInHousehold()),
    )
  })
})

describe('household join', () => {
  test('requires an invite code', () => {
    story(
      update,
      given(initialModel()),
      message(Message.SubmittedJoinHousehold()),
      model(model => {
        expect(model.join.maybeError).toStrictEqual(
          Option.some('کد دعوت را وارد کنید.'),
        )
      }),
      Command.expectNone(),
    )
  })

  test('joining tells the parent which household was joined', () => {
    story(
      update,
      given(
        modifyFields(initialModel(), {
          join: () =>
            modifyFields(initialModel().join, {
              inviteCode: () => 'invite-code',
            }),
        }),
      ),
      message(Message.SubmittedJoinHousehold()),
      Command.expectExact(
        SubmitJoinHousehold({ inviteCode: InviteCode.make(inviteCode) }),
      ),
      Command.resolve(
        SubmitJoinHousehold,
        Message.SucceededJoinHousehold({
          household: HouseholdSummary.make({
            id: householdId,
            name: householdName,
            inviteCode,
          }),
        }),
      ),
      expectOutMessage(OutMessage.JoinedHousehold({ householdId })),
    )
  })

  test('a failed join shows the server message', () => {
    story(
      update,
      given(
        modifyFields(initialModel(), {
          join: () =>
            modifyFields(initialModel().join, {
              inviteCode: () => 'bad-code',
            }),
        }),
      ),
      message(Message.SubmittedJoinHousehold()),
      Command.resolve(
        SubmitJoinHousehold,
        Message.FailedJoinHousehold({
          failure: { code: 'InviteInvalid', retryable: false },
        }),
      ),
      model(model => {
        expect(model.join.maybeError).toStrictEqual(
          Option.some('کد دعوت معتبر نیست.'),
        )
      }),
      expectNoOutMessage(),
    )
  })
})

describe('invite panel', () => {
  const createdModel = modifyFields(initialModel(), {
    maybeCreated: () =>
      Option.some(
        HouseholdSummary.make({
          id: householdId,
          name: householdName,
          inviteCode,
        }),
      ),
  })

  test('copying the invite code records the result', () => {
    story(
      update,
      given(createdModel),
      message(Message.ClickedCopyInviteCode()),
      Command.expectExact(CopyInviteCode({ inviteCode })),
      Command.resolve(
        CopyInviteCode,
        Message.CompletedCopyInviteCode({ isCopied: true }),
      ),
      model(model => {
        expect(model.isCopied).toBe(true)
      }),
    )
  })

  test('continuing asks the parent to open today', () => {
    story(
      update,
      given(createdModel),
      message(Message.ClickedContinue()),
      expectOutMessage(OutMessage.RequestedToday()),
    )
  })
})
