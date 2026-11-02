import { Button } from '@foldkit/ui'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { classNames } from './class-names'

type Child = Html | string

/**
 * The shared button primitive, built on the Foldkit UI `Button` helper.
 *
 * The helper supplies the ARIA attributes and the disabled/autofocus wiring;
 * this wrapper owns the variant classes and the spinner, so screens keep
 * rendering it with the Foldkit builder through `attributes.button`. Colours
 * come from the owned `.btn` rules in `styles.css`; the button carries none of
 * its own.
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
  /** Round icon-only button; pair it with `ariaLabel`. */
  isCircle?: boolean
  /** Shows a spinner and makes the button inert while the action runs. */
  isLoading?: boolean
  isDisabled?: boolean
  isAutofocus?: boolean
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
      ? [h.span([h.Class('spinner spinner-xs')]), ...config.children]
      : config.children

  return Button.view<Message>({
    type: config.type ?? 'button',
    ...(isInactive || config.onClick === undefined
      ? {}
      : { onClick: config.onClick }),
    ...(isInactive ? { isDisabled: true } : {}),
    ...(config.isAutofocus === true ? { isAutofocus: true } : {}),
      toView: (attributes: Button.ButtonAttributes<Message>) =>
        h.button(
          [
            ...attributes.button,
            ...(config.ariaLabel === undefined
              ? []
              : [h.AriaLabel(config.ariaLabel)]),
            ...(config.title === undefined ? [] : [h.Title(config.title)]),
            h.Class(
              classNames(
                'btn',
                VARIANT_CLASS[config.variant ?? 'primary'],
                SIZE_CLASS[config.size ?? 'md'],
                config.isSquare === true ? 'btn-square' : undefined,
                config.isCircle === true ? 'btn-circle' : undefined,
                config.isLoading === true ? undefined : config.class,
              ),
            ),
          ],
          children,
        ),
    },
    h,
  )
}
