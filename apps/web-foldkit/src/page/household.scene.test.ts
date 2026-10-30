import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  expectOutMessage,
  given,
  label,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { InviteCode } from '@tali/domain'

import { HouseholdSummary } from '../household-summary'
import {
  CopyInviteCode,
  Message,
  OutMessage,
  SubmitCreateHousehold,
  SubmitJoinHousehold,
  initialModel,
  update,
  view,
} from './household'

const householdId = '0192f0a0-0000-7000-8000-000000000002'
const householdName = 'خانه‌ی ما'
const inviteCode = 'invite-code'

const viewWithName = (
  model: Parameters<typeof view>[0],
  h: Parameters<typeof view>[2],
) => view(model, { maybeDisplayName: Option.some('مالک') }, h)

describe('household screen', () => {
  test('greets the user and offers both ways into a household', () => {
    scene(
      { update, view: viewWithName },
      given(initialModel()),
      expect(text('خوش آمدید، مالک.')).toExist(),
      expect(role('heading', { name: 'ساختن خانه' })).toExist(),
      expect(role('heading', { name: 'پیوستن به خانه' })).toExist(),
    )
  })

  test('joining with an empty code shows the validation message', () => {
    scene(
      { update, view: viewWithName },
      given(initialModel()),
      click(role('button', { name: 'پیوستن' })),
      expect(text('کد دعوت را وارد کنید.')).toExist(),
      Command.expectNone(),
    )
  })

  test('creating a household reveals the invite code and continues', () => {
    scene(
      { update, view: viewWithName },
      given(initialModel()),
      click(role('button', { name: 'ساختن خانه' })),
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
      expect(role('heading', { name: 'خانه ساخته شد' })).toExist(),
      expect(text('invite-code')).toExist(),
      click(role('button', { name: 'کپی کد' })),
      Command.expectExact(CopyInviteCode({ inviteCode })),
      Command.resolve(
        CopyInviteCode,
        Message.CompletedCopyInviteCode({ isCopied: true }),
      ),
      expect(role('button', { name: 'کپی شد' })).toExist(),
      click(role('button', { name: 'ادامه به امروز' })),
      expectOutMessage(OutMessage.RequestedToday()),
    )
  })

  test('typing an invite code enables the join form', () => {
    scene(
      { update, view: viewWithName },
      given(initialModel()),
      type(label('کد دعوت'), 'invite-code'),
      click(role('button', { name: 'پیوستن' })),
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
})
