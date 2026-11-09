import { Option } from 'effect'
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
  TextareaAttribute,
} from 'foldkit/html'

import { Input, Textarea } from '@foldkit/ui'

import { classNames } from './class-names'

/**
 * Form primitives built on the Foldkit UI `Input` and `Textarea` helpers,
 * ported from the old daisyUI-based wrappers. The helpers carry the ARIA
 * label/description linking and the input attributes; this wrapper owns the
 * layout (label above, hint below) and the owned `field-input` classes. They
 * carry no colour of their own, so every surface, border and focus ring
 * follows the active theme.
 */

const LABEL_CLASS = 'text-sm font-medium text-base-content/70'
const HINT_CLASS = 'text-xs text-base-content/50'

export type TextInputConfig<Message> = Readonly<{
  id: string
  label: string
  value: string
  onInput: (value: string) => Message
  hint?: string
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url'
  name?: string
  autoComplete?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  placeholder?: string
  /** Id of a `<datalist>` with suggestions for this input. */
  listId?: string
  isDisabled?: boolean
  isRequired?: boolean
  isInvalid?: boolean
  class?: string
}>

export const textInputView = <Message>(
  config: TextInputConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const hasHint = config.hint !== undefined

  return Input.view(
    {
      id: config.id,
      value: config.value,
      ...(config.onInput === undefined ? {} : { onInput: config.onInput }),
      type: config.type ?? 'text',
      ...(config.placeholder === undefined
        ? {}
        : { placeholder: config.placeholder }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.isDisabled === true ? { isDisabled: true } : {}),
      ...(config.isInvalid === true ? { isInvalid: true } : {}),
      ...(hasHint ? { hasDescription: true } : {}),
      toView: attributes =>
        h.div(
          [h.Class(classNames('grid gap-1.5', config.class))],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.label],
            ),
            h.input([
              ...attributes.input,
              // 16px keeps iOS from zooming the page when the field takes focus.
              h.Class(classNames('field-input min-h-[2.75rem] text-base')),
              ...(config.autoComplete === undefined
                ? []
                : [h.Autocomplete(config.autoComplete)]),
              ...(config.dir === undefined ? [] : [h.Dir(config.dir)]),
              ...(config.listId === undefined ? [] : [h.List(config.listId)]),
              ...(config.isRequired === true ? [h.Required(true)] : []),
            ]),
            ...(hasHint
              ? [
                  h.span(
                    [...attributes.description, h.Class(HINT_CLASS)],
                    [config.hint],
                  ),
                ]
              : []),
          ],
        ),
    },
    h,
  )
}

export type TextAreaConfig<Message> = Readonly<{
  id: string
  label: string
  value: string
  onInput: (value: string) => Message
  hint?: string
  name?: string
  rows?: number
  placeholder?: string
  isDisabled?: boolean
  isInvalid?: boolean
  spellcheck?: boolean
  class?: string
}>

export const textAreaFieldView = <Message>(
  config: TextAreaConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const hasHint = config.hint !== undefined

  return Textarea.view(
    {
      id: config.id,
      value: config.value,
      ...(config.onInput === undefined ? {} : { onInput: config.onInput }),
      rows: config.rows ?? 4,
      ...(config.placeholder === undefined
        ? {}
        : { placeholder: config.placeholder }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.isDisabled === true ? { isDisabled: true } : {}),
      ...(config.isInvalid === true ? { isInvalid: true } : {}),
      ...(hasHint ? { hasDescription: true } : {}),
      toView: attributes =>
        h.div(
          [h.Class(classNames('grid gap-1.5', config.class))],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.label],
            ),
            h.textarea([
              ...attributes.textarea,
              h.Class(classNames('field-input')),
              ...(config.spellcheck === undefined
                ? []
                : [h.Spellcheck(config.spellcheck)]),
            ]),
            ...(hasHint
              ? [
                  h.span(
                    [...attributes.description, h.Class(HINT_CLASS)],
                    [config.hint],
                  ),
                ]
              : []),
          ],
        ),
    },
    h,
  )
}

export type InputControlConfig<Message> = Readonly<{
  id: string
  label: string
  value: string
  onInput: (value: string) => Message
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url'
  name?: string
  autoComplete?: string
  placeholder?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  isDisabled?: boolean
  isRequired?: boolean
  isInvalid?: boolean
  class?: string
  /** Extra attributes appended after the accessible ones, such as key handlers. */
  attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
}>

/** A labelled-by-call-site input: the caller owns the visible label, this
 *  renders the `@foldkit/ui` input control with its ARIA hooks. Use it inside
 *  compact rows and toolbars where the standard stacked field is too tall. */
export const inputControlView = <Message>(
  config: InputControlConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      onInput: config.onInput,
      type: config.type ?? 'text',
      ...(config.placeholder === undefined
        ? {}
        : { placeholder: config.placeholder }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.isDisabled === true ? { isDisabled: true } : {}),
      ...(config.isInvalid === true ? { isInvalid: true } : {}),
      toView: attributes =>
        h.input([
          ...attributes.input,
          h.AriaLabel(config.label),
          h.Class(classNames('field-input', config.class)),
          ...(config.autoComplete === undefined
            ? []
            : [h.Autocomplete(config.autoComplete)]),
          ...(config.dir === undefined ? [] : [h.Dir(config.dir)]),
          ...(config.isRequired === true ? [h.Required(true)] : []),
          ...(config.attributes ?? []),
        ]),
    },
    h,
  )

export type TextAreaControlConfig<Message> = Readonly<{
  id: string
  label: string
  value: string
  onInput: (value: string) => Message
  rows?: number
  placeholder?: string
  name?: string
  isDisabled?: boolean
  isInvalid?: boolean
  spellcheck?: boolean
  class?: string
  /** Extra attributes appended after the accessible ones, such as key handlers. */
  attributes?: ReadonlyArray<TextareaAttribute<Message> | ChildAttribute>
}>

/** The textarea counterpart of {@link inputControlView}. */
export const textAreaControlView = <Message>(
  config: TextAreaControlConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Textarea.view(
    {
      id: config.id,
      value: config.value,
      onInput: config.onInput,
      rows: config.rows ?? 4,
      ...(config.placeholder === undefined
        ? {}
        : { placeholder: config.placeholder }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.isDisabled === true ? { isDisabled: true } : {}),
      ...(config.isInvalid === true ? { isInvalid: true } : {}),
      toView: attributes =>
        h.textarea([
          ...attributes.textarea,
          h.AriaLabel(config.label),
          h.Class(classNames('field-input', config.class)),
          ...(config.spellcheck === undefined
            ? []
            : [h.Spellcheck(config.spellcheck)]),
          ...(config.attributes ?? []),
        ]),
    },
    h,
  )

export const formErrorView = <Message>(
  maybeMessage: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeMessage, {
    onNone: () => h.empty,
    onSome: message =>
      h.div(
        [h.Role('alert'), h.Class('notice notice-error text-sm leading-7')],
        [h.span([], [message])],
      ),
  })
