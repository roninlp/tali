import { Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { classNames } from './class-names'

type Child = Html | string

/**
 * Form primitives built on daisyUI's field components, ported from
 * `apps/web/src/components/form.tsx`. They carry no colour of their own, so
 * every surface, border and focus ring follows the active theme.
 */

export type FieldConfig = Readonly<{
  id: string
  label: string
  children: ReadonlyArray<Child>
  hint?: string
  class?: string
}>

export const fieldView = <Message>(
  config: FieldConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(classNames('grid gap-1.5', config.class))],
    [
      h.label(
        [h.For(config.id), h.Class('text-sm font-medium text-base-content/70')],
        [config.label],
      ),
      ...config.children,
      ...(config.hint === undefined
        ? []
        : [h.span([h.Class('text-xs text-base-content/50')], [config.hint])]),
    ],
  )

export type TextInputConfig<Message> = Readonly<{
  id: string
  value: string
  onInput: (value: string) => Message
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url'
  name?: string
  autoComplete?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  placeholder?: string
  /** Id of a `<datalist>` with suggestions for this input. */
  listId?: string
  isDisabled?: boolean
  isRequired?: boolean
  class?: string
}>

export const textInputView = <Message>(
  config: TextInputConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.input([
    h.Id(config.id),
    h.Type(config.type ?? 'text'),
    h.Value(config.value),
    // 16px keeps iOS from zooming the page when the field takes focus.
    h.Style({ 'min-height': '2.75rem', 'font-size': '1rem' }),
    h.Class(classNames('input w-full', config.class)),
    ...(config.name === undefined ? [] : [h.Name(config.name)]),
    ...(config.autoComplete === undefined
      ? []
      : [h.Autocomplete(config.autoComplete)]),
    ...(config.dir === undefined ? [] : [h.Dir(config.dir)]),
    ...(config.placeholder === undefined
      ? []
      : [h.Placeholder(config.placeholder)]),
    ...(config.listId === undefined ? [] : [h.List(config.listId)]),
    ...(config.isDisabled === true ? [h.Disabled(true)] : []),
    ...(config.isRequired === true ? [h.Required(true)] : []),
    h.OnInput(config.onInput),
  ])

export type SelectOption = Readonly<{ value: string; label: string }>

export type SelectInputConfig<Message> = Readonly<{
  id: string
  value: string
  options: ReadonlyArray<SelectOption>
  onChange: (value: string) => Message
  name?: string
  isDisabled?: boolean
  class?: string
}>

export const selectInputView = <Message>(
  config: SelectInputConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.select(
    [
      h.Id(config.id),
      h.Value(config.value),
      h.Class(classNames('select w-full', config.class)),
      ...(config.name === undefined ? [] : [h.Name(config.name)]),
      ...(config.isDisabled === true ? [h.Disabled(true)] : []),
      h.OnChange(config.onChange),
    ],
    config.options.map(option =>
      h.option([h.Value(option.value)], [option.label]),
    ),
  )

export const formErrorView = <Message>(
  maybeMessage: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeMessage, {
    onNone: () => h.empty,
    onSome: message =>
      h.div(
        [
          h.Role('alert'),
          h.Class(
            'alert alert-error items-start gap-2 py-2.5 text-sm leading-7',
          ),
        ],
        [h.span([], [message])],
      ),
  })
