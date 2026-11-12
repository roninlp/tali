import { Option, Schema } from 'effect'
import { Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { describe, expect, test } from 'vitest'

import { Listbox } from '@foldkit/ui'

import {
  foldFieldChild,
  listboxOutMessageFold,
  optionalListboxOutMessageFold,
} from './fold'

const ChildModel = Schema.Struct({ count: Schema.Int })

type ChildModel = typeof ChildModel.Type

const ChildMessage = defineMessageUnion({
  ClickedIncrement: {},
})

type ChildMessage = typeof ChildMessage.Type

const ChildOutMessage = defineMessageUnion({
  ReachedTwo: { count: Schema.Int },
})

type ChildOutMessage = typeof ChildOutMessage.Type

const childUpdate = (
  model: ChildModel,
  _message: ChildMessage,
): Update.ReturnWithOutMessage<ChildModel, ChildMessage, ChildOutMessage> => {
  const next = { count: model.count + 1 }

  return next.count === 2
    ? {
        model: next,
        outMessage: ChildOutMessage.ReachedTwo({ count: next.count }),
      }
    : { model: next }
}

const ParentMessage = defineMessageUnion({
  GotChildMessage: { message: ChildMessage },
})

type ParentMessage = typeof ParentMessage.Type

type ParentModel = Readonly<{ child: ChildModel; lastReachedCount: number }>

const foldChild = foldFieldChild({
  update: childUpdate,
  field: (model: ParentModel) => model.child,
  setField: (model, nextChild) => ({ ...model, child: nextChild }),
  toParentMessage: message => ParentMessage.GotChildMessage({ message }),
  foldOutMessage: ChildOutMessage.match<
    Update.Step<ParentModel, ParentMessage>
  >({
    ReachedTwo:
      ({ count }) =>
      stepModel => ({ model: { ...stepModel, lastReachedCount: count } }),
  }),
})

describe('foldFieldChild', () => {
  test('writes the child result back into its parent field', () => {
    const result = foldChild(
      { child: { count: 0 }, lastReachedCount: 0 },
      ChildMessage.ClickedIncrement(),
    )

    expect(result.model.child.count).toBe(1)
    expect(result.model.lastReachedCount).toBe(0)
  })

  test('folds the child OutMessage against the written-back parent Model', () => {
    const result = foldChild(
      { child: { count: 1 }, lastReachedCount: 0 },
      ChildMessage.ClickedIncrement(),
    )

    expect(result.model.child.count).toBe(2)
    expect(result.model.lastReachedCount).toBe(2)
  })
})

// LISTBOX

const SelectionMessage = defineMessageUnion({
  SelectedValue: { value: Schema.String },
})

type SelectionMessage = typeof SelectionMessage.Type

type SelectionModel = Readonly<{ applied: string }>

const selectionUpdate = (
  _model: SelectionModel,
  message: SelectionMessage,
): Update.Return<SelectionModel, SelectionMessage> =>
  SelectionMessage.match(message, {
    SelectedValue: ({ value }) => ({ model: { applied: value } }),
  })

const foldSelection = listboxOutMessageFold<SelectionModel, SelectionMessage>({
  handleUpdate: selectionUpdate,
  toMessage: (_model, value) => SelectionMessage.SelectedValue({ value }),
})

const foldMaybeSelection = optionalListboxOutMessageFold<
  SelectionModel,
  SelectionMessage
>({
  handleUpdate: selectionUpdate,
  toMessage: (model, value) =>
    model.applied === value
      ? Option.none()
      : Option.some(SelectionMessage.SelectedValue({ value })),
})

describe('listboxOutMessageFold', () => {
  test('runs the parent update on the selected value', () => {
    const step = foldSelection(Listbox.OutMessage.Selected({ value: 'tasks' }))
    const result = step({ applied: 'لیست' })

    expect(result.model.applied).toBe('tasks')
  })
})

describe('optionalListboxOutMessageFold', () => {
  test('applies the selection when the parent resolves a message', () => {
    const step = foldMaybeSelection(
      Listbox.OutMessage.Selected({ value: 'tasks' }),
    )

    const result = step({ applied: 'لیست' })

    expect(result.model.applied).toBe('tasks')
  })

  test('leaves the Model untouched when the parent resolves no message', () => {
    const model = { applied: 'tasks' }

    const step = foldMaybeSelection(
      Listbox.OutMessage.Selected({ value: 'tasks' }),
    )

    const result = step(model)

    expect(result.model).toBe(model)
    expect(result.commands).toBeUndefined()
  })
})
