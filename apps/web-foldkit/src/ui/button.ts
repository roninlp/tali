import type { Html, HtmlBuilder } from 'foldkit/html'

import { classNames } from './class-names'

type Child = Html | string

/**
 * The shared button primitive.
 *
 * Ported from `@tali/ui`'s Solid `Button` as a plain view helper: the app's
 * screens render it with the Foldkit builder, so it takes attributes and
 * children instead of JSX props. Colours come from the active daisyUI theme;
 * the button carries none of its own.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'neutral'
  | 'ghost'
  | 'outline'
  | 'soft'
  | 'error'
  | 'success'

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  accent: 'btn-accent',
  neutral: 'btn-neutral',
  ghost: 'btn-ghost',
  outline: 'btn-outline',
  soft: 'btn-soft',
  error: 'btn-error',
  success: 'btn-success',
}

const SIZE_CLASS: Readonly<Record<ButtonSize, string>> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
}

export type ButtonConfig<Message> = Readonly<{
  children: ReadonlyArray<Child>
  onClick?: Message
  variant?: ButtonVariant
  size?: ButtonSize
  /** Square icon-only button; pair it with `ariaLabel`. */
  isSquare?: boolean
  /** Shows a spinner and makes the button inert while the action runs. */
  isLoading?: boolean
  isDisabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  ariaLabel?: string
  title?: string
  class?: string
}>

export const buttonView = <Message>(
  config: ButtonConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const isInactive = config.isDisabled === true || config.isLoading === true

  const children: ReadonlyArray<Child> =
    config.isLoading === true
      ? [
          h.span([h.Class('loading loading-spinner loading-xs')]),
          ...config.children,
        ]
      : config.children

  return h.button(
    [
      h.Type(config.type ?? 'button'),
      h.Class(
        classNames(
          'btn',
          VARIANT_CLASS[config.variant ?? 'primary'],
          SIZE_CLASS[config.size ?? 'md'],
          config.isSquare === true ? 'btn-square' : undefined,
          config.class,
        ),
      ),
      ...(isInactive ? [h.Disabled(true)] : []),
      ...(config.isLoading === true ? [h.AriaBusy(true)] : []),
      ...(config.ariaLabel === undefined
        ? []
        : [h.AriaLabel(config.ariaLabel)]),
      ...(config.title === undefined ? [] : [h.Title(config.title)]),
      ...(config.onClick === undefined || isInactive
        ? []
        : [h.OnClick(config.onClick)]),
    ],
    children,
  )
}
