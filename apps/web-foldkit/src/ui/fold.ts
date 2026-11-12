import { Option } from 'effect'
import { Update } from 'foldkit'

import { Listbox } from '@foldkit/ui'

/**
 * Shared plumbing for the child Submodels a screen mounts in a plain Model
 * field.
 *
 * The update half of `h.submodel` is always the same three facts: the child's
 * `update`, the `read`/`write` pair into the parent Model, and the `Got*`
 * wrapper that lifts the child's `Message` back to the parent. Only the child
 * type and the field change per screen, so these helpers take the field
 * accessors plus the child's own config and return the fold. The OutMessage
 * Step still belongs to the screen: it is the one piece that differs.
 */

/** Read and write one child Submodel the parent owns directly. A direct child
 *  is always mounted, so its fold reads `Option.some` instead of matching a
 *  nullable field. */
export type ChildField<ParentModel, ChildModel> = Readonly<{
  field: (model: ParentModel) => ChildModel
  setField: (model: ParentModel, nextChild: ChildModel) => ParentModel
}>

/** `Update.foldChild` for a child the parent owns in a plain field. */
export const foldFieldChild = <
  ParentModel,
  ParentMessage,
  ChildModel,
  Input,
  ChildMessage,
  ChildOutMessage,
  ChildRequirements = never,
  OutMessageStepRequirements = ChildRequirements,
  OutMessageStepMessage = ParentMessage,
>(
  config: Readonly<
    ChildField<ParentModel, ChildModel> &
      Omit<
        Update.ChildFoldWithOutMessage<
          ParentModel,
          ParentMessage,
          ChildModel,
          Input,
          ChildMessage,
          ChildOutMessage,
          ChildRequirements,
          OutMessageStepRequirements,
          OutMessageStepMessage
        >,
        'read' | 'write'
      >
  >,
): Update.Fold<
  ParentModel,
  ParentMessage | OutMessageStepMessage,
  Input,
  ChildRequirements | OutMessageStepRequirements
> =>
  Update.foldChild({
    update: config.update,
    read: (model: ParentModel) => Option.some(config.field(model)),
    write: config.setField,
    toParentMessage: config.toParentMessage,
    foldOutMessage: config.foldOutMessage,
  })

/** `Update.foldChildStep` for a child entry point that takes only its Model. */
export const foldFieldChildStep = <
  ParentModel,
  ParentMessage,
  ChildModel,
  ChildMessage,
  ChildOutMessage,
  ChildRequirements = never,
  OutMessageStepRequirements = ChildRequirements,
  OutMessageStepMessage = ParentMessage,
>(
  config: Readonly<
    ChildField<ParentModel, ChildModel> &
      Omit<
        Update.ChildStepFoldWithOutMessage<
          ParentModel,
          ParentMessage,
          ChildModel,
          ChildMessage,
          ChildOutMessage,
          ChildRequirements,
          OutMessageStepRequirements,
          OutMessageStepMessage
        >,
        'read' | 'write'
      >
  >,
): Update.Step<
  ParentModel,
  ParentMessage | OutMessageStepMessage,
  ChildRequirements | OutMessageStepRequirements
> =>
  Update.foldChildStep({
    update: config.update,
    read: (model: ParentModel) => Option.some(config.field(model)),
    write: config.setField,
    toParentMessage: config.toParentMessage,
    foldOutMessage: config.foldOutMessage,
  })

type ListboxSelectionFold<
  ParentModel,
  ParentMessage,
  ParentOutMessage,
  Requirements,
  Value extends string,
> = Readonly<{
  handleUpdate: (
    model: ParentModel,
    message: ParentMessage,
  ) => Update.ReturnWithOutMessage<
    ParentModel,
    ParentMessage,
    ParentOutMessage,
    Requirements
  >
  toMaybeMessage: (
    model: ParentModel,
    value: Value,
  ) => Option.Option<ParentMessage>
}>

const listboxSelectedStep = <
  ParentModel,
  ParentMessage,
  ParentOutMessage = never,
  Requirements = never,
  Value extends string = string,
>(
  config: ListboxSelectionFold<
    ParentModel,
    ParentMessage,
    ParentOutMessage,
    Requirements,
    Value
  >,
) =>
  Listbox.OutMessage.match<
    Update.StepWithOutMessage<
      ParentModel,
      ParentMessage,
      ParentOutMessage,
      Requirements
    >,
    Listbox.OutMessage<Value>
  >({
    Selected:
      ({ value }) =>
      stepModel =>
        Option.match(config.toMaybeMessage(stepModel, value), {
          onNone: () => ({ model: stepModel }),
          onSome: message => config.handleUpdate(stepModel, message),
        }),
  })

/**
 * The OutMessage Step for a `Listbox` whose selection always becomes a parent
 * `Message`.
 *
 * A listbox reports a single `Selected` variant carrying the chosen value, so
 * every screen wrote the same matcher and differed only in which Message the
 * value produced. `toMessage` also receives the Model, because some screens
 * resolve their target from current state rather than from the value.
 */
export const listboxOutMessageFold = <
  ParentModel,
  ParentMessage,
  ParentOutMessage = never,
  Requirements = never,
  Value extends string = string,
>(
  config: Readonly<{
    toMessage: (model: ParentModel, value: Value) => ParentMessage
    handleUpdate: (
      model: ParentModel,
      message: ParentMessage,
    ) => Update.ReturnWithOutMessage<
      ParentModel,
      ParentMessage,
      ParentOutMessage,
      Requirements
    >
  }>,
) =>
  listboxSelectedStep({
    handleUpdate: config.handleUpdate,
    toMaybeMessage: (model: ParentModel, value: Value) =>
      Option.some(config.toMessage(model, value)),
  })

/** {@link listboxOutMessageFold} for a selection that may not apply, such as a
 *  listbox shown without an open item: `None` leaves the Model unchanged. */
export const optionalListboxOutMessageFold = <
  ParentModel,
  ParentMessage,
  ParentOutMessage = never,
  Requirements = never,
  Value extends string = string,
>(
  config: Readonly<{
    toMessage: (
      model: ParentModel,
      value: Value,
    ) => Option.Option<ParentMessage>
    handleUpdate: (
      model: ParentModel,
      message: ParentMessage,
    ) => Update.ReturnWithOutMessage<
      ParentModel,
      ParentMessage,
      ParentOutMessage,
      Requirements
    >
  }>,
) =>
  listboxSelectedStep({
    handleUpdate: config.handleUpdate,
    toMaybeMessage: config.toMessage,
  })
