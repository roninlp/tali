import { Submodel } from 'foldkit'

import type { TaskBucketBounds } from '@tali/domain'

import * as Calendar from '../page/calendar'
import {
  calendarPickerDialogView,
  eventQuickAddFormView,
  occasionFormView,
  type OccasionFormConfig,
} from '../page/calendar-view'
import * as Habits from '../page/habits'
import { habitFormView, habitPickerDialogView } from '../page/habits-view'
import * as Tasks from '../page/tasks'
import { taskPickerDialogView, taskQuickAddView } from '../page/tasks-view'
import * as NoteForm from './note-form'

/**
 * Branded views that expose each page's create form to `h.submodel`.
 *
 * The form keeps living on the page Submodel, so the dialog and the page share
 * one draft, one validation pass, and one write Command.
 */

export type TaskCreateFormInputs = Readonly<{
  inputs: Tasks.Inputs
  bounds: TaskBucketBounds
}>

export const TaskCreateFormView = Submodel.defineView<
  Tasks.Model,
  Tasks.Message,
  TaskCreateFormInputs
>((model, viewInputs, h) =>
  taskQuickAddView(model, viewInputs.inputs, viewInputs.bounds, h),
)

export type HabitCreateFormInputs = Readonly<{
  inputs: Habits.Inputs
  showHeading: boolean
}>

export const HabitCreateFormView = Submodel.defineView<
  Habits.Model,
  Habits.Message,
  HabitCreateFormInputs
>((model, viewInputs, h) =>
  habitFormView(model, viewInputs.inputs, h, {
    showHeading: viewInputs.showHeading,
  }),
)

export type EventCreateFormInputs = Readonly<{
  inputs: Calendar.Inputs
  date: string
  label: string
}>

export const EventCreateFormView = Submodel.defineView<
  Calendar.Model,
  Calendar.Message,
  EventCreateFormInputs
>((model, viewInputs, h) =>
  eventQuickAddFormView(
    model,
    viewInputs.inputs,
    viewInputs.date,
    viewInputs.label,
    h,
  ),
)

export type OccasionCreateFormInputs = Readonly<{
  inputs: Calendar.Inputs
  form: OccasionFormConfig
}>

export const OccasionCreateFormView = Submodel.defineView<
  Calendar.Model,
  Calendar.Message,
  OccasionCreateFormInputs
>((model, viewInputs, h) =>
  occasionFormView(model, viewInputs.inputs, viewInputs.form, h),
)

export const NoteCreateFormView = Submodel.defineView<
  NoteForm.Model,
  NoteForm.Message,
  NoteForm.Inputs
>((model, inputs, h) => NoteForm.view(model, inputs, h))

export const TaskPickerDialogView = Submodel.defineView<
  Tasks.Model,
  Tasks.Message,
  Tasks.Inputs
>((model, inputs, h) => taskPickerDialogView(model, inputs, h))

export const HabitPickerDialogView = Submodel.defineView<
  Habits.Model,
  Habits.Message,
  Habits.Inputs
>((model, inputs, h) => habitPickerDialogView(model, inputs, h))

export const CalendarPickerDialogView = Submodel.defineView<
  Calendar.Model,
  Calendar.Message,
  Calendar.Inputs
>((model, inputs, h) => calendarPickerDialogView(model, inputs, h))
