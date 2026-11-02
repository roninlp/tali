import { Listbox } from '@foldkit/ui'
import { Array, Option } from 'effect'
import { type Html, type HtmlBuilder, childAttributes } from 'foldkit/html'

import { chevronDownIcon } from './icons'

/**
 * Shared chrome for the Foldkit UI `Listbox` submodels that replace the old
 * native `<select>` pickers. Each call site declares its own
 * `Listbox.create<Item>()` bundle and Model field, then composes the
 * submodel through `h.submodel` with `listboxViewInputs`; the pieces here
 * keep the trigger, panel, and item classes consistent across screens.
 */

export const LISTBOX_ANCHOR = {
  placement: 'bottom-start' as const,
  gap: 4,
  padding: 8,
}

const TRIGGER_CLASS = 'listbox-trigger'
const PANEL_CLASS = 'float-card min-w-44'
const PANEL_SCROLL_CLASS = 'max-h-72 overflow-auto py-1'

export const listboxTriggerContent = <Message>(
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class('flex w-full items-center justify-between gap-2 min-w-0')],
    [
      h.span([h.Class('truncate')], [label]),
      chevronDownIcon('size-3.5 shrink-0 text-base-content/50'),
    ],
  )

type ListboxRow<Value extends string> = Readonly<{ value: Value; label: string }>

/** Selected-label resolver for `Listbox` pickers over `{ value, label }` rows. */
export const selectedListboxLabel = <Value extends string>(
  config: Readonly<{
    items: ReadonlyArray<ListboxRow<Value>>
    maybeSelectedValue: Option.Option<Value>
  }>,
): string =>
  Option.match(config.maybeSelectedValue, {
    onNone: () => '',
    onSome: selected =>
      Option.getOrElse(
        Option.map(
          Array.findFirst(
            config.items,
            item => item.value === selected,
          ),
          item => item.label,
        ),
        () => selected,
      ),
  })

/**
 * The shared `ViewInputs` for a `Listbox` over `{ value, label }` rows:
 * trigger + panel chrome, selected row highlighting, chevron in the button.
 * Pass the selection through `maybeSelectedValue` and set `isDisabled` while
 * the screen is saving.
 */
export const listboxViewInputs = <Message, Value extends string>(
  config: Readonly<{
    items: ReadonlyArray<ListboxRow<Value>>
    maybeSelectedValue: Option.Option<Value>
    h: HtmlBuilder<Message>
    isDisabled?: boolean
  }>,
): Listbox.ViewInputs<ListboxRow<Value>, Value> => {
  const h = config.h

  return {
    anchor: LISTBOX_ANCHOR,
    items: config.items,
    itemToValue: item => item.value,
    maybeSelectedValue: config.maybeSelectedValue,
    itemToConfig: item => ({
      className: 'listbox-item',
      content: h.span([h.Class('truncate')], [item.label]),
    }),
    ...(config.isDisabled === true ? { isButtonDisabled: true } : {}),
    buttonContent: listboxTriggerContent(
      selectedListboxLabel({
        items: config.items,
        maybeSelectedValue: config.maybeSelectedValue,
      }),
      h,
    ),
    buttonAttributes: childAttributes([h.Class(`${TRIGGER_CLASS} w-full`)]),
    itemsClassName: PANEL_CLASS,
    itemsScrollClassName: PANEL_SCROLL_CLASS,
    backdropAttributes: childAttributes([h.Class('float-backdrop')]),
    attributes: childAttributes([h.Class('relative')]),
  }
}
