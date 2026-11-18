import { Option } from 'effect'
import { Subscription, Update } from 'foldkit'

import type { ChildField } from './ui/fold'

/**
 * The root's page table: one declarative slice per household screen, folded
 * by a generic consumer.
 *
 * The root owns every screen Submodel in a plain Model field, and the wiring
 * around each one repeats the same facts: which field holds the child, how
 * the child's Messages lift to the root, which Inputs the root derives for
 * it, what its entry capability runs on route entry, and which subscriptions
 * it owns. A slice records those facts as data, and `pageFold` — or
 * `pageFoldWithOutMessage`, when the page's update surfaces an OutMessage —
 * builds them into the folds and subscriptions the root's `update` arms,
 * route entries, and subscription aggregate consume.
 *
 * The view half stays hand-written in `main.ts`. `Submodel.View` is a
 * conditional on concrete ViewInputs, so a fold generic over a page's types
 * cannot assemble the `h.submodel` call without a type assertion; the
 * framework's own generic embeds (`ui/toast.ts`'s `toastStackView`, the
 * website's `snippetCopy/renderer`) are generic only over the parent
 * message for exactly this reason.
 *
 * The slice shape covers the screens whose page wiring follows one mold.
 * Screens that serve several routes off one Submodel (lists, notes), drive
 * the session from their OutMessages (login, register, household), take no
 * Inputs (reminders), or compose a section of several Submodels (settings)
 * stay hand-wired in `main.ts`.
 */

// SLICE

/** The subscription policy of a slice: the child's own entries, started and
 *  stopped by a root condition such as the active route. */
type PageSlotSubscriptions<ParentModel, ChildModel, ChildMessage> = Readonly<{
  child: Subscription.Subscriptions<ChildModel, ChildMessage>
  when: (model: ParentModel) => boolean
}>

/** One household screen's contribution to the root, as data. The field
 *  names read as the halves the root used to hand-roll per page:
 *  `field` is the `read`/`write` pair, `toParentMessage` the `Got*`
 *  wrapper, `update` with `inputs` the message fold, and `entered` the
 *  route entry fold. */
export type PageSlice<
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  ChildInputs,
  ChildRequirements = never,
> = Readonly<{
  field: ChildField<ParentModel, ChildModel>
  toParentMessage: (message: ChildMessage) => ParentMessage
  update: (
    childModel: ChildModel,
    message: ChildMessage,
    inputs: ChildInputs,
  ) => Update.Return<ChildModel, ChildMessage, ChildRequirements>
  inputs: (model: ParentModel) => ChildInputs
  entered: (
    childModel: ChildModel,
    inputs: ChildInputs,
  ) => Update.Return<ChildModel, ChildMessage, ChildRequirements>
  subscriptions?: PageSlotSubscriptions<ParentModel, ChildModel, ChildMessage>
}>

/** {@link PageSlice} for a page whose update surfaces an OutMessage the root
 *  folds. `foldOutMessage` is the matcher the root used to name
 *  `fold*OutMessage`. */
export type PageSliceWithOutMessage<
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  ChildInputs,
  ChildOutMessage,
  ChildRequirements = never,
  OutStepRequirements = ChildRequirements,
> = Readonly<{
  field: ChildField<ParentModel, ChildModel>
  toParentMessage: (message: ChildMessage) => ParentMessage
  update: (
    childModel: ChildModel,
    message: ChildMessage,
    inputs: ChildInputs,
  ) => Update.ReturnWithOutMessage<
    ChildModel,
    ChildMessage,
    ChildOutMessage,
    ChildRequirements
  >
  inputs: (model: ParentModel) => ChildInputs
  foldOutMessage: (
    outMessage: ChildOutMessage,
    context: Update.FoldContext<ChildMessage, ParentMessage>,
  ) => Update.Step<ParentModel, ParentMessage, OutStepRequirements>
  entered: (
    childModel: ChildModel,
    inputs: ChildInputs,
  ) => Update.ReturnWithOutMessage<
    ChildModel,
    ChildMessage,
    ChildOutMessage,
    ChildRequirements
  >
  subscriptions?: PageSlotSubscriptions<ParentModel, ChildModel, ChildMessage>
}>

// WIRING

/** The folds and subscriptions one slice produces: the shape the root's
 *  `update` arms, route entries, and subscription aggregate consume. */
export type PageWiring<ParentModel, ParentMessage, ChildMessage, Requirements> =
  Readonly<{
    /** The page's `update` with its Inputs bound; reads as the old
     *  `fold*Message` arms. */
    foldMessage: (
      model: ParentModel,
      message: ChildMessage,
    ) => Update.Return<ParentModel, ParentMessage, Requirements>
    /** The page's entry capability with its Inputs bound, run on route
     *  entry. */
    foldEntered: (
      model: ParentModel,
    ) => Update.Return<ParentModel, ParentMessage, Requirements>
    /** The child's subscriptions, gated by the slice's condition, if the page
     *  owns any. */
    subscriptions:
      | Subscription.Subscriptions<ParentModel, ParentMessage>
      | undefined
  }>

// FOLD

const pageSubscriptions = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
>(
  field: ChildField<ParentModel, ChildModel>,
  toParentMessage: (message: ChildMessage) => ParentMessage,
  pageSubs:
    | PageSlotSubscriptions<ParentModel, ChildModel, ChildMessage>
    | undefined,
): Subscription.Subscriptions<ParentModel, ParentMessage> | undefined => {
  if (pageSubs === undefined) {
    return undefined
  }

  return Subscription.lift(pageSubs.child)<ParentModel, ParentMessage>({
    read: (model: ParentModel) =>
      pageSubs.when(model) ? Option.some(field.field(model)) : Option.none(),
    toParentMessage,
  })
}

/** Fold one page slice whose update returns no OutMessage. */
export const pageFold = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  ChildInputs,
  ChildRequirements = never,
>(
  slice: PageSlice<
    ParentModel,
    ParentMessage,
    ChildModel,
    ChildMessage,
    ChildInputs,
    ChildRequirements
  >,
): PageWiring<ParentModel, ParentMessage, ChildMessage, ChildRequirements> => {
  type MessageInput = Readonly<{ message: ChildMessage; inputs: ChildInputs }>

  type EnteredInput = Readonly<{ inputs: ChildInputs }>

  const foldPage = Update.foldChild({
    update: (childModel: ChildModel, input: MessageInput) =>
      slice.update(childModel, input.message, input.inputs),
    read: (model: ParentModel) => Option.some(slice.field.field(model)),
    write: slice.field.setField,
    toParentMessage: slice.toParentMessage,
  })

  const foldEntry = Update.foldChild({
    update: (childModel: ChildModel, input: EnteredInput) =>
      slice.entered(childModel, input.inputs),
    read: (model: ParentModel) => Option.some(slice.field.field(model)),
    write: slice.field.setField,
    toParentMessage: slice.toParentMessage,
  })

  return {
    foldMessage: (model: ParentModel, message: ChildMessage) =>
      foldPage(model, { message, inputs: slice.inputs(model) }),
    foldEntered: (model: ParentModel) =>
      foldEntry(model, { inputs: slice.inputs(model) }),
    subscriptions: pageSubscriptions(
      slice.field,
      slice.toParentMessage,
      slice.subscriptions,
    ),
  }
}

/** Fold one page slice whose update surfaces an OutMessage the root folds
 *  through the slice's `foldOutMessage`. */
export const pageFoldWithOutMessage = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  ChildInputs,
  ChildOutMessage,
  ChildRequirements = never,
  OutStepRequirements = ChildRequirements,
>(
  slice: PageSliceWithOutMessage<
    ParentModel,
    ParentMessage,
    ChildModel,
    ChildMessage,
    ChildInputs,
    ChildOutMessage,
    ChildRequirements,
    OutStepRequirements
  >,
): PageWiring<
  ParentModel,
  ParentMessage,
  ChildMessage,
  ChildRequirements | OutStepRequirements
> => {
  type MessageInput = Readonly<{ message: ChildMessage; inputs: ChildInputs }>

  type EnteredInput = Readonly<{ inputs: ChildInputs }>

  const foldPage = Update.foldChild({
    update: (childModel: ChildModel, input: MessageInput) =>
      slice.update(childModel, input.message, input.inputs),
    read: (model: ParentModel) => Option.some(slice.field.field(model)),
    write: slice.field.setField,
    toParentMessage: slice.toParentMessage,
    foldOutMessage: slice.foldOutMessage,
  })

  const foldEntry = Update.foldChild({
    update: (childModel: ChildModel, input: EnteredInput) =>
      slice.entered(childModel, input.inputs),
    read: (model: ParentModel) => Option.some(slice.field.field(model)),
    write: slice.field.setField,
    toParentMessage: slice.toParentMessage,
    foldOutMessage: slice.foldOutMessage,
  })

  return {
    foldMessage: (model: ParentModel, message: ChildMessage) =>
      foldPage(model, { message, inputs: slice.inputs(model) }),
    foldEntered: (model: ParentModel) =>
      foldEntry(model, { inputs: slice.inputs(model) }),
    subscriptions: pageSubscriptions(
      slice.field,
      slice.toParentMessage,
      slice.subscriptions,
    ),
  }
}
