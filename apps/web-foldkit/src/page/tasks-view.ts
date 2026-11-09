import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { Listbox } from '@foldkit/ui'
import { localizeDigits } from '@tali/domain'
import type { Digits, TaskBucketBounds } from '@tali/domain'

import { shareActionOf } from '../lib/visibility-writes'
import type { TagRow, TaskRow } from '../mirror'
import { taskKey } from '../mirror'
import { buttonView } from '../ui/button'
import { inputControlView, textAreaFieldView, textInputView } from '../ui/field'
import { chevronDownIcon } from '../ui/icons'
import { listboxViewInputs } from '../ui/listbox'
import { pickerDialogView, pickerTriggerView } from '../ui/picker'
import { Message } from './tasks'
import type {
  Model,
  QuickAddDraft,
  TaskEditor,
  TaskStatusEditorOption,
  TaskToast,
  ViewInputs,
} from './tasks'
import { quickAddDue } from './tasks'
import {
  DateListbox,
  PriorityListbox,
  QuickAddProjectListbox,
  SortListbox,
  StatusListbox,
  TaskPriorityListbox,
  TaskProjectListbox,
  TaskStatusListbox,
} from './tasks'
import {
  BOARD_COPY,
  DATE_OPTIONS,
  GROUP_TITLES,
  PRIORITY_CHOICES,
  PRIORITY_OPTIONS,
  ProjectFilter,
  SORT_FIELD_LABELS,
  STATUS_LABELS,
  STATUS_OPTIONS,
  TASK_SORT_FIELDS,
  type TaskBoard,
  type TaskView,
  activeFilterCount,
  buildTaskView,
  dueLabel,
  formatCompletionTime,
  formatLocalDate,
  liveTasks,
  noProjectCountOf,
  priorityLabel,
  projectCountsOf,
  projectOf,
  recentCompletions,
  shiftLocalDate,
  tagColor,
  tagsOfTask,
  validTimeZone,
} from './tasks-model'

/**
 * The Tasks board's view, ported from
 * `apps/web/src/components/tasks/tasks-screen.tsx` and its quick-add,
 * filter-panel, task-card, history, and tag-chip components.
 *
 * Three boards read the mirror through the page's view inputs; the quick-add
 * and inline editors write locally through Commands. Drag is an accelerator
 * over the always-visible move buttons, so a keyboard or touch user gets the
 * same day moves without a pointer.
 */

/**
 * A tag chip takes its colour from the `--tag-color` custom property the
 * projection supplies, so its utilities mix that variable with the theme
 * tokens rather than naming a colour of their own.
 */
const TAG_CLASS: string = [
  'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[0.72rem] leading-6 font-normal wrap-anywhere transition-colors',
  'border-[color:color-mix(in_oklch,var(--tag-color)_45%,var(--color-base-300))]',
  'bg-[color:color-mix(in_oklch,var(--tag-color)_12%,var(--color-base-100))]',
  'text-[color:color-mix(in_oklch,var(--tag-color)_70%,var(--color-base-content))]',
  'data-[selected=true]:bg-[color:color-mix(in_oklch,var(--tag-color)_30%,var(--color-base-100))]',
  'data-[selected=true]:font-semibold',
].join(' ')

const CHIP_CLASS: string = [
  'inline-flex max-w-full items-center gap-1 rounded-full border border-base-300 bg-base-200 px-2 py-0.5 text-[0.7rem] leading-6 text-base-content/70 wrap-anywhere',
  'data-[tone=overdue]:border-warning/35 data-[tone=overdue]:bg-warning/12 data-[tone=overdue]:text-warning',
  'data-[tone=high]:border-error/30 data-[tone=high]:bg-error/10 data-[tone=high]:text-error',
  'data-[tone=pending]:border-warning/30 data-[tone=pending]:bg-warning/12 data-[tone=pending]:text-warning',
  'data-[tone=error]:border-error/35 data-[tone=error]:bg-error/12 data-[tone=error]:text-error',
].join(' ')

/** The quick-add and filter pills: a quiet chip that lights up when active. */
const PILL_CLASS: string = [
  'inline-flex min-h-10 items-center rounded-full border border-base-300 bg-base-100 px-3 py-1 text-[0.8rem] text-base-content/70 transition-colors sm:min-h-9',
  'hover:border-base-content/20 hover:text-base-content disabled:opacity-55',
  'data-[active=true]:border-primary data-[active=true]:bg-primary/10 data-[active=true]:font-medium data-[active=true]:text-primary',
].join(' ')

const QUICK_PANEL_CLASS =
  'grid min-w-0 gap-2 rounded-xl border border-base-300 bg-base-200/60 p-3'

const CHIP_ROW_CLASS = 'flex min-w-0 flex-wrap items-center gap-1.5'

const INLINE_CREATE_CLASS = 'flex flex-wrap items-center gap-1.5'

const QUIET_CLASS = 'm-0 text-[0.78rem] leading-7 text-base-content/70'

const FIELD_CLASS = 'grid min-w-0 gap-1'

const SAVE_LABELS: Readonly<Record<TaskEditor['saveState'], string>> = {
  idle: '',
  saving: 'در حال ذخیره…',
  saved: 'ذخیره شد',
  error: 'ذخیره نشد؛ دوباره تلاش کنید',
}

const viewOf = (model: Model, inputs: ViewInputs): TaskView =>
  buildTaskView(inputs.mirror.tasks, {
    timeZone: validTimeZone(inputs.display.timeZone),
    now: new Date(model.now).toISOString(),
    filters: model.settings.filters,
    sort: model.settings.sort,
  })

const findEditor = (model: Model, taskId: string): TaskEditor | undefined =>
  model.editors.find(editor => editor.taskId === taskId)

const tagChipView = (
  tag: TagRow,
  maybeSelected: Option.Option<boolean>,
  maybeOnClick: Option.Option<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const style = { '--tag-color': tagColor(tag) }
  const isSelected = Option.getOrElse(maybeSelected, () => false)

  return Option.match(maybeOnClick, {
    onNone: () =>
      h.span(
        [
          h.Class(TAG_CLASS),
          h.Style(style),
          h.DataAttribute('selected', 'false'),
        ],
        [tag.name],
      ),
    onSome: onClick =>
      h.button(
        [
          h.Type('button'),
          h.Class(TAG_CLASS),
          h.Style(style),
          h.AriaPressed(isSelected ? 'true' : 'false'),
          h.DataAttribute('selected', isSelected ? 'true' : 'false'),
          h.OnClick(onClick),
        ],
        [tag.name],
      ),
  })
}

const chipView = (
  label: string,
  tone: string | undefined,
  h: HtmlBuilder<Message>,
  title?: string,
): Html =>
  h.span(
    [
      h.Class(CHIP_CLASS),
      ...(tone === undefined ? [] : [h.DataAttribute('tone', tone)]),
      ...(title === undefined ? [] : [h.Title(title)]),
    ],
    [label],
  )

// QUICK ADD

const quickAddDueLabel = (
  model: Model,
  inputs: ViewInputs,
  bounds: TaskBucketBounds,
  digits: Digits,
): string =>
  Option.match(quickAddDue(model, inputs), {
    onNone: () => 'بدون موعد',
    onSome: date =>
      date === bounds.today ? 'امروز' : formatLocalDate(date, digits),
  })

const quickAddPanelView = (
  model: Model,
  inputs: ViewInputs,
  view: TaskView,
  h: HtmlBuilder<Message>,
): Html => {
  const draft = model.quickAdd
  const dueValue = Option.getOrElse(quickAddDue(model, inputs), () => '')

  const duePresets: ReadonlyArray<{
    readonly label: string
    readonly value: Option.Option<string>
  }> = [
    { label: 'امروز', value: Option.some(view.bounds.today) },
    { label: 'فردا', value: Option.some(shiftLocalDate(view.bounds.today, 1)) },
    {
      label: 'هفتهٔ بعد',
      value: Option.some(shiftLocalDate(view.bounds.today, 7)),
    },
    { label: 'بدون تاریخ', value: Option.none() },
  ]

  return Option.match(draft.maybePanel, {
    onNone: () => h.empty,
    onSome: panel => {
      if (panel === 'due') {
        return h.div(
          [h.Id('tasks-quick-add-due'), h.Class(QUICK_PANEL_CLASS)],
          [
            h.div(
              [h.Role('group'), h.AriaLabel('موعد'), h.Class(CHIP_ROW_CLASS)],
              Array.map(duePresets, option => {
                const isActive =
                  dueValue === Option.getOrElse(option.value, () => '')

                return h.button(
                  [
                    h.Type('button'),
                    h.Class(PILL_CLASS),
                    h.DataAttribute('active', isActive ? 'true' : 'false'),
                    h.AriaPressed(isActive ? 'true' : 'false'),
                    h.OnClick(
                      Message.SelectedQuickAddDuePreset({
                        maybeDueDate: option.value,
                      }),
                    ),
                  ],
                  [option.label],
                )
              }),
            ),
            pickerTriggerView(
              {
                id: 'tasks-quick-add-due-date',
                label: 'تاریخ دلخواه',
                target: 'quickAdd:due',
                mode: 'date',
                value: dueValue,
                today: view.bounds.today,
                digits: inputs.display.digits,
                toParentMessage: message =>
                  Message.GotPickerMessage({ message }),
              },
              h,
            ),
          ],
        )
      }

      if (panel === 'priority') {
        return h.div(
          [h.Id('tasks-quick-add-priority'), h.Class(QUICK_PANEL_CLASS)],
          [
            h.div(
              [h.Role('group'), h.AriaLabel('اولویت'), h.Class(CHIP_ROW_CLASS)],
              Array.map(PRIORITY_CHOICES, choice =>
                h.button(
                  [
                    h.Type('button'),
                    h.Class(PILL_CLASS),
                    h.AriaPressed(
                      draft.priority === choice.value ? 'true' : 'false',
                    ),
                    h.DataAttribute(
                      'active',
                      draft.priority === choice.value ? 'true' : 'false',
                    ),
                    h.OnClick(
                      Message.SelectedQuickAddPriority({
                        priority: choice.value,
                      }),
                    ),
                  ],
                  [choice.label],
                ),
              ),
            ),
          ],
        )
      }

      if (panel === 'tags') {
        return h.div(
          [h.Id('tasks-quick-add-tags'), h.Class(QUICK_PANEL_CLASS)],
          [
            Array.match(inputs.mirror.tags, {
              onEmpty: () =>
                h.p([h.Class(QUIET_CLASS)], ['هنوز برچسبی ندارید.']),
              onNonEmpty: tags =>
                h.div(
                  [h.Class(CHIP_ROW_CLASS)],
                  Array.map(tags, tag =>
                    tagChipView(
                      tag,
                      Option.some(draft.tagIds.includes(tag.id)),
                      Option.some(
                        Message.ToggledQuickAddTag({ tagId: tag.id }),
                      ),
                      h,
                    ),
                  ),
                ),
            }),
            h.div(
              [h.Class(INLINE_CREATE_CLASS)],
              [
                inputControlView(
                  {
                    id: 'tasks-quick-add-new-tag',
                    label: 'نام برچسب تازه',
                    value: draft.newTagName,
                    placeholder: 'برچسب تازه…',
                    isDisabled: !inputs.isStoreReady,
                    class: 'min-w-0 flex-1 basis-36',
                    onInput: value => Message.UpdatedQuickAddNewTag({ value }),
                    attributes: [
                      h.OnKeyDownPreventDefault(key =>
                        key === 'Enter'
                          ? Option.some(
                              Message.SubmittedQuickAddTag({
                                name: draft.newTagName,
                              }),
                            )
                          : Option.none(),
                      ),
                    ],
                  },
                  h,
                ),
                h.button(
                  [
                    h.Type('button'),
                    h.Class(PILL_CLASS),
                    h.Disabled(
                      !inputs.isStoreReady || draft.newTagName.trim() === '',
                    ),
                    h.OnClick(
                      Message.SubmittedQuickAddTag({
                        name: draft.newTagName,
                      }),
                    ),
                  ],
                  ['ساخت برچسب'],
                ),
              ],
            ),
          ],
        )
      }

      return h.div(
        [h.Id('tasks-quick-add-project'), h.Class(QUICK_PANEL_CLASS)],
        [
          h.label(
            [h.Class(FIELD_CLASS)],
            [
              h.span(
                [h.Class('text-[0.76rem] text-base-content/70')],
                ['پروژه'],
              ),
              h.submodel({
                slotId: model.quickAddProjectListbox.id,
                model: model.quickAddProjectListbox,
                view: QuickAddProjectListbox.view,
                viewInputs: listboxViewInputs({
                  items: [
                    { value: '', label: 'بدون پروژه' },
                    ...Array.map(inputs.mirror.projects, project => ({
                      value: project.id,
                      label: project.title,
                    })),
                  ],
                  maybeSelectedValue: Option.some(
                    Option.getOrElse(draft.maybeProjectId, () => ''),
                  ),
                  h,
                }),
                toParentMessage: message =>
                  Message.GotQuickAddProjectListboxMessage({ message }),
              }),
            ],
          ),
          h.div(
            [h.Class(INLINE_CREATE_CLASS)],
            [
              inputControlView(
                {
                  id: 'tasks-quick-add-new-project',
                  label: 'نام پروژه‌ی تازه',
                  value: draft.newProjectTitle,
                  placeholder: 'پروژه‌ی تازه…',
                  isDisabled: !inputs.isStoreReady,
                  class: 'min-w-0 flex-1 basis-36',
                  onInput: value =>
                    Message.UpdatedQuickAddNewProject({ value }),
                  attributes: [
                    h.OnKeyDownPreventDefault(key =>
                      key === 'Enter'
                        ? Option.some(
                            Message.SubmittedQuickAddProject({
                              title: draft.newProjectTitle,
                            }),
                          )
                        : Option.none(),
                    ),
                  ],
                },
                h,
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(PILL_CLASS),
                  h.Disabled(
                    !inputs.isStoreReady || draft.newProjectTitle.trim() === '',
                  ),
                  h.OnClick(
                    Message.SubmittedQuickAddProject({
                      title: draft.newProjectTitle,
                    }),
                  ),
                ],
                ['ساخت پروژه'],
              ),
            ],
          ),
        ],
      )
    },
  })
}

const quickAddStatusView = (
  draft: QuickAddDraft,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(draft.maybeError, {
    onSome: message =>
      h.p(
        [
          h.Role('status'),
          h.AriaLive('polite'),
          h.Class('m-0 text-[0.76rem] leading-6 text-error'),
        ],
        [message],
      ),
    onNone: () =>
      draft.hasSaved
        ? h.p(
            [
              h.Role('status'),
              h.AriaLive('polite'),
              h.Class('m-0 text-[0.76rem] leading-6 text-base-content/70'),
            ],
            ['ذخیره شد؛ در صف همگام‌سازی.'],
          )
        : h.empty,
  })

const quickAddView = (
  model: Model,
  inputs: ViewInputs,
  view: TaskView,
  h: HtmlBuilder<Message>,
): Html => {
  const draft = model.quickAdd
  const digits = inputs.display.digits

  const projectTitle = Option.match(draft.maybeProjectId, {
    onNone: () => 'پروژه',
    onSome: projectId =>
      Option.match(
        Option.fromNullishOr(projectOf(inputs.mirror.projects, projectId)),
        {
          onNone: () => 'پروژه',
          onSome: project => `پروژه: ${project.title}`,
        },
      ),
  })

  return h.form(
    [
      h.AriaLabel('افزودن سریع کار'),
      h.Class('panel grid grid-cols-1 min-w-0 gap-3 p-4 sm:p-5'),
      h.OnSubmit(Message.SubmittedQuickAdd()),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          inputControlView(
            {
              id: 'tasks-quick-add',
              label: 'عنوان کار تازه',
              value: draft.title,
              placeholder: 'یک کار تازه… (مثلاً خرید شیر)',
              isDisabled: !inputs.isStoreReady,
              class: 'min-h-11 min-w-0 flex-1 basis-48',
              onInput: value => Message.UpdatedQuickAddTitle({ value }),
            },
            h,
          ),
          buttonView(
            {
              type: 'submit',
              isDisabled:
                !inputs.isStoreReady ||
                draft.isAdding ||
                draft.title.trim() === '',
              isLoading: draft.isAdding,
              class: 'min-h-11',
              children: ['افزودن'],
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Role('group'), h.AriaLabel('جزئیات کار'), h.Class(CHIP_ROW_CLASS)],
        [
          h.button(
            [
              h.Type('button'),
              h.Class(PILL_CLASS),
              h.DataAttribute(
                'active',
                Option.contains(draft.maybePanel, 'due') ||
                  quickAddDue(model, inputs) !== Option.none()
                  ? 'true'
                  : 'false',
              ),
              h.AriaExpanded(Option.contains(draft.maybePanel, 'due')),
              h.AriaControls('tasks-quick-add-due'),
              h.OnClick(Message.ClickedToggleQuickAddPanel({ panel: 'due' })),
            ],
            [`موعد: ${quickAddDueLabel(model, inputs, view.bounds, digits)}`],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(PILL_CLASS),
              h.DataAttribute(
                'active',
                Option.contains(draft.maybePanel, 'priority') ||
                  draft.priority !== 'medium'
                  ? 'true'
                  : 'false',
              ),
              h.AriaExpanded(Option.contains(draft.maybePanel, 'priority')),
              h.AriaControls('tasks-quick-add-priority'),
              h.OnClick(
                Message.ClickedToggleQuickAddPanel({ panel: 'priority' }),
              ),
            ],
            [`اولویت: ${priorityLabel(draft.priority)}`],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(PILL_CLASS),
              h.DataAttribute(
                'active',
                Option.contains(draft.maybePanel, 'tags') ||
                  draft.tagIds.length > 0
                  ? 'true'
                  : 'false',
              ),
              h.AriaExpanded(Option.contains(draft.maybePanel, 'tags')),
              h.AriaControls('tasks-quick-add-tags'),
              h.OnClick(Message.ClickedToggleQuickAddPanel({ panel: 'tags' })),
            ],
            [
              draft.tagIds.length > 0
                ? `برچسب‌ها: ${localizeDigits(draft.tagIds.length, digits)}`
                : 'برچسب‌ها',
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(PILL_CLASS),
              h.DataAttribute(
                'active',
                Option.contains(draft.maybePanel, 'project') ||
                  Option.isSome(draft.maybeProjectId)
                  ? 'true'
                  : 'false',
              ),
              h.AriaExpanded(Option.contains(draft.maybePanel, 'project')),
              h.AriaControls('tasks-quick-add-project'),
              h.OnClick(
                Message.ClickedToggleQuickAddPanel({ panel: 'project' }),
              ),
            ],
            [projectTitle],
          ),
        ],
      ),
      quickAddPanelView(model, inputs, view, h),
      quickAddStatusView(draft, h),
    ],
  )
}

// FILTER PANEL

const projectButtonView = (
  label: string,
  count: number,
  isSelected: boolean,
  onSelect: Message,
  digits: Digits,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(
        'flex min-h-10 min-w-0 items-center justify-between gap-2 rounded-lg border-0 bg-transparent px-2 py-2 text-start text-[0.84rem] text-base-content/75 transition-colors hover:bg-base-content/5 aria-pressed:bg-primary/10 aria-pressed:font-medium aria-pressed:text-primary',
      ),
      h.AriaPressed(isSelected ? 'true' : 'false'),
      h.DataAttribute('selected', isSelected ? 'true' : 'false'),
      h.OnClick(onSelect),
    ],
    [
      h.span([h.Class('min-w-0 wrap-anywhere')], [label]),
      count > 0
        ? h.span(
            [
              h.Class(
                'flex-none text-[0.72rem] text-base-content/70 tabular-nums',
              ),
            ],
            [localizeDigits(count, digits)],
          )
        : h.empty,
    ],
  )

const filterPanelView = (
  model: Model,
  inputs: ViewInputs,
  view: TaskView,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const live = liveTasks(inputs.mirror.tasks)
  const counts = projectCountsOf(live)
  const active = activeFilterCount(model.settings.filters)

  return h.div(
    [h.Class('panel grid grid-cols-1 min-w-0 gap-3 p-4 sm:p-5')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            'ms-auto inline-flex min-h-10 items-center justify-center rounded-full border border-base-300 bg-base-100 px-3.5 py-1 text-[0.8rem] text-base-content/70 transition-colors hover:border-base-content/20 hover:text-base-content lg:hidden',
          ),
          h.OnClick(Message.ClickedToggleFilters()),
        ],
        ['بستن فیلترها'],
      ),
      h.header(
        [h.Class('grid gap-0.5')],
        [
          h.h2([h.Class('m-0 text-[0.95rem] font-bold')], ['فیلتر و مرتب‌سازی']),
          h.p(
            [h.Class('m-0 text-[0.78rem] leading-6 text-base-content/70')],
            [
              `${localizeDigits(view.total, digits)} کار · امروز ${localizeDigits(
                view.counts.today,
                digits,
              )} · آینده ${localizeDigits(
                view.counts.upcoming,
                digits,
              )} · بدون تاریخ ${localizeDigits(view.counts.inbox, digits)}`,
            ],
          ),
        ],
      ),
      h.section(
        [h.AriaLabelledBy('tasks-filter-projects'), h.Class('grid gap-1')],
        [
          h.h3(
            [
              h.Id('tasks-filter-projects'),
              h.Class('m-0 text-[0.82rem] font-medium text-base-content/70'),
            ],
            ['پروژه‌ها'],
          ),
          h.div(
            [h.Class('grid gap-0.5')],
            [
              projectButtonView(
                'همه‌ی کارها',
                live.length,
                ProjectFilter.isAnyOf(['All'])(model.settings.filters.project),
                Message.SelectedProjectFilter({ project: ProjectFilter.All() }),
                digits,
                h,
              ),
              ...Array.map(inputs.mirror.projects, project =>
                projectButtonView(
                  project.title,
                  counts.get(project.id) ?? 0,
                  ProjectFilter.guards.Project(
                    model.settings.filters.project,
                  ) && model.settings.filters.project.projectId === project.id,
                  Message.SelectedProjectFilter({
                    project: ProjectFilter.Project({ projectId: project.id }),
                  }),
                  digits,
                  h,
                ),
              ),
              projectButtonView(
                'بدون پروژه',
                noProjectCountOf(live),
                ProjectFilter.isAnyOf(['None'])(model.settings.filters.project),
                Message.SelectedProjectFilter({
                  project: ProjectFilter.None(),
                }),
                digits,
                h,
              ),
            ],
          ),
          h.div(
            [h.Class(INLINE_CREATE_CLASS)],
            [
              inputControlView(
                {
                  id: 'tasks-new-project',
                  label: 'نام پروژه‌ی تازه',
                  value: model.newProjectTitle,
                  placeholder: 'پروژه‌ی تازه…',
                  isDisabled: !inputs.isStoreReady,
                  class: 'min-w-0 flex-1 basis-36',
                  onInput: value => Message.UpdatedNewProjectTitle({ value }),
                  attributes: [
                    h.OnKeyDownPreventDefault(key =>
                      key === 'Enter'
                        ? Option.some(
                            Message.SubmittedFilterProject({
                              title: model.newProjectTitle,
                            }),
                          )
                        : Option.none(),
                    ),
                  ],
                },
                h,
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(PILL_CLASS),
                  h.Disabled(
                    !inputs.isStoreReady || model.newProjectTitle.trim() === '',
                  ),
                  h.OnClick(
                    Message.SubmittedFilterProject({
                      title: model.newProjectTitle,
                    }),
                  ),
                ],
                ['ساخت'],
              ),
            ],
          ),
        ],
      ),
      h.section(
        [h.AriaLabelledBy('tasks-filter-tags'), h.Class('grid gap-1')],
        [
          h.h3(
            [
              h.Id('tasks-filter-tags'),
              h.Class('m-0 text-[0.82rem] font-medium text-base-content/70'),
            ],
            [
              model.settings.filters.tagIds.length > 0
                ? `برچسب‌ها (${localizeDigits(
                    model.settings.filters.tagIds.length,
                    digits,
                  )})`
                : 'برچسب‌ها',
            ],
          ),
          Array.match(inputs.mirror.tags, {
            onEmpty: () => h.p([h.Class(QUIET_CLASS)], ['هنوز برچسبی ندارید.']),
            onNonEmpty: tags =>
              h.div(
                [h.Class(CHIP_ROW_CLASS)],
                Array.map(tags, tag =>
                  tagChipView(
                    tag,
                    Option.some(model.settings.filters.tagIds.includes(tag.id)),
                    Option.some(Message.ToggledFilterTag({ tagId: tag.id })),
                    h,
                  ),
                ),
              ),
          }),
          h.div(
            [h.Class(INLINE_CREATE_CLASS)],
            [
              inputControlView(
                {
                  id: 'tasks-new-tag',
                  label: 'نام برچسب تازه',
                  value: model.newTagName,
                  placeholder: 'برچسب تازه…',
                  isDisabled: !inputs.isStoreReady,
                  class: 'min-w-0 flex-1 basis-36',
                  onInput: value => Message.UpdatedNewTagName({ value }),
                  attributes: [
                    h.OnKeyDownPreventDefault(key =>
                      key === 'Enter'
                        ? Option.some(
                            Message.SubmittedFilterTag({
                              name: model.newTagName,
                            }),
                          )
                        : Option.none(),
                    ),
                  ],
                },
                h,
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class(PILL_CLASS),
                  h.Disabled(
                    !inputs.isStoreReady || model.newTagName.trim() === '',
                  ),
                  h.OnClick(
                    Message.SubmittedFilterTag({ name: model.newTagName }),
                  ),
                ],
                ['ساخت'],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class('grid gap-1.5')],
        [
          h.label(
            [
              h.For(Listbox.buttonId(model.priorityListbox.id)),
              h.Class('text-sm font-medium text-base-content/70'),
            ],
            ['اولویت'],
          ),
          h.submodel({
            slotId: model.priorityListbox.id,
            model: model.priorityListbox,
            view: PriorityListbox.view,
            viewInputs: listboxViewInputs({
              items: PRIORITY_OPTIONS,
              maybeSelectedValue: Option.some(model.settings.filters.priority),
              h,
            }),
            toParentMessage: message =>
              Message.GotPriorityListboxMessage({ message }),
          }),
        ],
      ),
      h.div(
        [h.Class('grid gap-1.5')],
        [
          h.label(
            [
              h.For(Listbox.buttonId(model.statusListbox.id)),
              h.Class('text-sm font-medium text-base-content/70'),
            ],
            ['وضعیت'],
          ),
          h.submodel({
            slotId: model.statusListbox.id,
            model: model.statusListbox,
            view: StatusListbox.view,
            viewInputs: listboxViewInputs({
              items: STATUS_OPTIONS,
              maybeSelectedValue: Option.some(model.settings.filters.status),
              h,
            }),
            toParentMessage: message =>
              Message.GotStatusListboxMessage({ message }),
          }),
        ],
      ),
      h.div(
        [h.Class('grid gap-1.5')],
        [
          h.label(
            [
              h.For(Listbox.buttonId(model.dateListbox.id)),
              h.Class('text-sm font-medium text-base-content/70'),
            ],
            ['زمان'],
          ),
          h.submodel({
            slotId: model.dateListbox.id,
            model: model.dateListbox,
            view: DateListbox.view,
            viewInputs: listboxViewInputs({
              items: DATE_OPTIONS,
              maybeSelectedValue: Option.some(model.settings.filters.date),
              h,
            }),
            toParentMessage: message =>
              Message.GotDateListboxMessage({ message }),
          }),
        ],
      ),
      h.div(
        [h.Class('grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1')],
        [
          h.div(
            [h.Class('grid gap-1.5')],
            [
              h.label(
                [
                  h.For(Listbox.buttonId(model.sortListbox.id)),
                  h.Class('text-sm font-medium text-base-content/70'),
                ],
                ['مرتب‌سازی'],
              ),
              h.submodel({
                slotId: model.sortListbox.id,
                model: model.sortListbox,
                view: SortListbox.view,
                viewInputs: listboxViewInputs({
                  items: Array.map(TASK_SORT_FIELDS, field => ({
                    value: field,
                    label: SORT_FIELD_LABELS[field],
                  })),
                  maybeSelectedValue: Option.some(model.settings.sort.by),
                  h,
                }),
                toParentMessage: message =>
                  Message.GotSortListboxMessage({ message }),
              }),
            ],
          ),
          buttonView(
            {
              type: 'button',
              variant: 'outline',
              size: 'sm',
              class: 'self-end',
              ariaLabel:
                model.settings.sort.direction === 'asc'
                  ? 'مرتب‌سازی صعودی'
                  : 'مرتب‌سازی نزولی',
              title:
                model.settings.sort.direction === 'asc' ? 'صعودی' : 'نزولی',
              onClick: Message.ToggledSortDirection(),
              children: [model.settings.sort.direction === 'asc' ? '↑' : '↓'],
            },
            h,
          ),
        ],
      ),
      active > 0
        ? h.button(
            [
              h.Type('button'),
              h.Class(PILL_CLASS),
              h.OnClick(Message.ClickedClearFilters()),
            ],
            [`پاک کردن فیلترها (${localizeDigits(active, digits)})`],
          )
        : h.empty,
      h.p(
        [h.Class('m-0 text-[0.72rem] leading-6 text-base-content/70')],
        ['فیلترها و مرتب‌سازی روی همین دستگاه ذخیره می‌شوند.'],
      ),
    ],
  )
}

// TASK CARD

const STATUS_EDITOR_OPTIONS: ReadonlyArray<TaskStatusEditorOption> = [
  { value: 'todo', label: STATUS_LABELS.todo },
  { value: 'doing', label: STATUS_LABELS.doing },
]

const statusValue = (status: TaskRow['status']): 'todo' | 'doing' =>
  status === 'doing' ? 'doing' : 'todo'

const moveButton = (
  label: string,
  maybeDueDate: Option.Option<string>,
  task: TaskRow,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(
        'inline-flex min-h-8 items-center rounded-full border border-base-300 bg-base-100 px-2.5 text-[0.68rem] text-base-content/70 transition-colors hover:border-primary hover:bg-primary/8 hover:text-primary',
      ),
      h.OnClick(
        Message.ClickedMoveTask({
          taskId: task.id,
          title: task.title,
          maybeDueDate,
        }),
      ),
    ],
    [label],
  )

const editorView = (
  maybeUserId: Option.Option<string>,
  task: TaskRow,
  editor: TaskEditor,
  today: string,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const editorId = `task-${task.id}-editor`

  return h.div(
    [
      h.Id(editorId),
      h.Class('grid min-w-0 gap-3 border-t border-dashed border-base-300 pt-3'),
    ],
    [
      textInputView(
        {
          id: `task-${task.id}-title`,
          label: 'عنوان',
          value: editor.title,
          class: 'min-w-0',
          onInput: value =>
            Message.UpdatedTaskTitle({ taskId: task.id, value }),
        },
        h,
      ),
      textAreaFieldView(
        {
          id: `task-${task.id}-description`,
          label: 'توضیح',
          value: editor.description,
          rows: 3,
          class: 'min-w-0',
          onInput: value =>
            Message.UpdatedTaskDescription({ taskId: task.id, value }),
        },
        h,
      ),
      h.div(
        [
          h.Class(
            'grid min-w-0 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]',
          ),
        ],
        [
          pickerTriggerView(
            {
              id: `task-${task.id}-due`,
              label: 'موعد',
              target: `task:${task.id}:due`,
              mode: 'date',
              value: editor.dueDate,
              today,
              digits: inputs.display.digits,
              toParentMessage: message => Message.GotPickerMessage({ message }),
            },
            h,
          ),
          h.div(
            [h.Class('grid gap-1.5')],
            [
              h.label(
                [
                  h.For(Listbox.buttonId(editor.priorityListbox.id)),
                  h.Class('text-sm font-medium text-base-content/70'),
                ],
                ['اولویت'],
              ),
              h.submodel({
                slotId: editor.priorityListbox.id,
                model: editor.priorityListbox,
                view: TaskPriorityListbox.view,
                viewInputs: listboxViewInputs({
                  items: PRIORITY_CHOICES,
                  maybeSelectedValue: Option.some(task.priority),
                  h,
                  isDisabled: !inputs.isStoreReady,
                }),
                toParentMessage: message =>
                  Message.GotTaskPriorityListboxMessage({
                    taskId: task.id,
                    message,
                  }),
              }),
            ],
          ),
          h.div(
            [h.Class('grid gap-1.5')],
            [
              h.label(
                [
                  h.For(Listbox.buttonId(editor.statusListbox.id)),
                  h.Class('text-sm font-medium text-base-content/70'),
                ],
                ['وضعیت'],
              ),
              h.submodel({
                slotId: editor.statusListbox.id,
                model: editor.statusListbox,
                view: TaskStatusListbox.view,
                viewInputs: listboxViewInputs({
                  items: STATUS_EDITOR_OPTIONS,
                  maybeSelectedValue: Option.some(statusValue(task.status)),
                  h,
                  isDisabled: !inputs.isStoreReady,
                }),
                toParentMessage: message =>
                  Message.GotTaskStatusListboxMessage({
                    taskId: task.id,
                    message,
                  }),
              }),
            ],
          ),
          h.div(
            [h.Class('grid gap-1.5')],
            [
              h.label(
                [
                  h.For(Listbox.buttonId(editor.projectListbox.id)),
                  h.Class('text-sm font-medium text-base-content/70'),
                ],
                ['پروژه'],
              ),
              h.submodel({
                slotId: editor.projectListbox.id,
                model: editor.projectListbox,
                view: TaskProjectListbox.view,
                viewInputs: listboxViewInputs({
                  items: [
                    { value: '', label: 'بدون پروژه' },
                    ...Array.map(inputs.mirror.projects, project => ({
                      value: project.id,
                      label: project.title,
                    })),
                  ],
                  maybeSelectedValue: Option.some(task.projectId ?? ''),
                  h,
                  isDisabled: !inputs.isStoreReady,
                }),
                toParentMessage: message =>
                  Message.GotTaskProjectListboxMessage({
                    taskId: task.id,
                    message,
                  }),
              }),
            ],
          ),
        ],
      ),
      h.div(
        [h.Role('group'), h.AriaLabel('برچسب‌ها'), h.Class(FIELD_CLASS)],
        [
          h.span([h.Class('text-[0.76rem] text-base-content/70')], ['برچسب‌ها']),
          Array.match(inputs.mirror.tags, {
            onEmpty: () =>
              h.p([h.Class(QUIET_CLASS)], ['هنوز برچسبی ساخته نشده است.']),
            onNonEmpty: tags =>
              h.div(
                [h.Class(CHIP_ROW_CLASS)],
                Array.map(tags, tag =>
                  tagChipView(
                    tag,
                    Option.some(editor.tagIds.includes(tag.id)),
                    Option.some(
                      Message.ToggledTaskTag({
                        taskId: task.id,
                        tagId: tag.id,
                      }),
                    ),
                    h,
                  ),
                ),
              ),
          }),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center justify-start gap-2')],
        [
          ...(Option.exists(maybeUserId, userId => userId === task.ownerId)
            ? [
                buttonView(
                  {
                    type: 'button',
                    variant: 'ghost',
                    size: 'sm',
                    onClick: Message.ClickedToggleTaskVisibility({
                      taskId: task.id,
                    }),
                    children: [
                      shareActionOf(task.visibility ?? 'shared').label,
                    ],
                  },
                  h,
                ),
              ]
            : []),
          buttonView(
            {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              onClick: Message.ClickedCloseTaskEditor({ taskId: task.id }),
              children: ['بستن'],
            },
            h,
          ),
        ],
      ),
    ],
  )
}

const taskMetaView = (
  inputs: ViewInputs,
  view: TaskView,
  task: TaskRow,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const overdue = task.dueDate !== null && task.dueDate < view.bounds.today
  const project = projectOf(inputs.mirror.projects, task.projectId)
  const tags = tagsOfTask(inputs.mirror.tags, task.tagIds)
  const isPending = Array.contains(inputs.pendingKeys, taskKey(task.id))

  return h.div(
    [h.Class('flex min-w-0 flex-wrap items-center gap-1')],
    [
      chipView(
        dueLabel(task, view.bounds, digits),
        overdue ? 'overdue' : undefined,
        h,
      ),
      task.priority === 'high'
        ? chipView(`اولویت: ${priorityLabel(task.priority)}`, 'high', h)
        : h.empty,
      task.status === 'doing'
        ? chipView('در حال انجام', undefined, h)
        : h.empty,
      Option.match(Option.fromNullishOr(project), {
        onNone: () => h.empty,
        onSome: entry => chipView(entry.title, undefined, h),
      }),
      ...Array.map(tags, tag =>
        tagChipView(tag, Option.none(), Option.none(), h),
      ),
      isPending
        ? chipView('در صف', 'pending', h, 'در انتظار همگام‌سازی')
        : h.empty,
      task.hasSyncError
        ? chipView('خطای همگام‌سازی', 'error', h, 'ذخیره در سرور ناموفق بود')
        : h.empty,
    ],
  )
}

const moveActionsView = (
  task: TaskRow,
  view: TaskView,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel(`جابه‌جایی ${task.title}`),
      h.Class('flex flex-wrap gap-1'),
    ],
    [
      task.dueDate === view.bounds.today
        ? h.empty
        : moveButton('امروز', Option.some(view.bounds.today), task, h),
      task.dueDate === view.bounds.tomorrow
        ? h.empty
        : moveButton('فردا', Option.some(view.bounds.tomorrow), task, h),
      moveButton(
        'هفتهٔ بعد',
        Option.some(shiftLocalDate(view.bounds.today, 7)),
        task,
        h,
      ),
      task.dueDate === null
        ? h.empty
        : moveButton('بدون تاریخ', Option.none(), task, h),
    ],
  )

const taskCardView = (
  model: Model,
  inputs: ViewInputs,
  view: TaskView,
  task: TaskRow,
  h: HtmlBuilder<Message>,
): Html => {
  const editor = findEditor(model, task.id)
  const overdue = task.dueDate !== null && task.dueDate < view.bounds.today
  const editorId = `task-${task.id}-editor`
  const saveLabel = editor === undefined ? '' : SAVE_LABELS[editor.saveState]

  return h.keyed('li')(
    task.id,
    [
      h.Id(`task-${task.id}`),
      h.Class(
        [
          'grid min-w-0 gap-2 rounded-xl border border-base-300 bg-base-100 p-3 shadow-panel transition-colors',
          'data-[overdue=true]:border-warning/35 data-[overdue=true]:bg-warning/[0.07]',
          'data-[dragging=true]:opacity-50',
          'target:border-primary target:bg-primary/[0.07]',
        ].join(' '),
      ),
      h.DataAttribute('overdue', overdue ? 'true' : 'false'),
      h.DataAttribute(
        'dragging',
        Option.contains(model.maybeDraggingId, task.id) ? 'true' : 'false',
      ),
    ],
    [
      h.div(
        [h.Class('flex min-w-0 items-start gap-2')],
        [
          h.span(
            [
              h.Draggable(true),
              h.AriaHidden(true),
              h.Title('بکشید تا به روز دیگری برود'),
              h.Class(
                'hidden cursor-grab select-none px-0.5 py-1 text-[0.9rem] text-base-content/70 lg:inline-flex',
              ),
              h.OnDragStart(Message.StartedTaskDrag({ taskId: task.id })),
              h.OnDragEnd(Message.EndedTaskDrag()),
            ],
            ['⠿'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'relative grid size-5 flex-none place-items-center rounded-full border-[1.5px] border-base-300 bg-base-100 text-[0.62rem] text-transparent transition-colors before:absolute before:-inset-2.5 before:content-[""] hover:border-secondary hover:bg-secondary/8 hover:text-secondary active:scale-90',
              ),
              h.AriaLabel(`انجام دادن: ${task.title}`),
              h.Title('انجام دادن'),
              h.OnClick(
                Message.ClickedCompleteTask({
                  taskId: task.id,
                  title: task.title,
                  maybeStartedAt: Option.fromNullishOr(task.startedAt),
                }),
              ),
            ],
            [h.span([h.AriaHidden(true)], ['✓'])],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'min-w-0 flex-1 cursor-pointer rounded-md border-0 bg-transparent p-0 text-start text-[0.9rem] leading-7 font-semibold wrap-anywhere hover:text-primary hover:underline hover:underline-offset-4',
              ),
              h.AriaExpanded(editor !== undefined),
              h.AriaControls(editorId),
              h.OnClick(Message.ClickedTaskTitle({ taskId: task.id })),
            ],
            [task.title],
          ),
        ],
      ),
      editor === undefined &&
      task.description !== null &&
      task.description !== ''
        ? h.p(
            [
              h.Class(
                'm-0 text-[0.82rem] leading-7 text-base-content/70 wrap-anywhere',
              ),
            ],
            [task.description],
          )
        : h.empty,
      taskMetaView(inputs, view, task, h),
      moveActionsView(task, view, h),
      editor !== undefined && editor.saveState !== 'idle'
        ? h.span(
            [
              h.Class(
                'min-h-[1.2em] text-[0.72rem] leading-6 text-base-content/70 data-[state=saved]:text-success data-[state=error]:text-error',
              ),
              h.DataAttribute('state', editor.saveState),
              h.Role('status'),
              h.AriaLive('polite'),
            ],
            [saveLabel],
          )
        : h.empty,
      editor === undefined
        ? h.empty
        : editorView(
            model.maybeUserId,
            task,
            editor,
            view.bounds.today,
            inputs,
            h,
          ),
    ],
  )
}

// BOARDS

const boardView = (
  model: Model,
  inputs: ViewInputs,
  view: TaskView,
  board: TaskBoard,
  h: HtmlBuilder<Message>,
): Html => {
  const copy = BOARD_COPY[board.key]
  const headingId = `tasks-board-${board.key}`
  const groups = Array.filter(board.groups, group => group.tasks.length > 0)

  return h.section(
    [
      h.Class(
        'grid min-w-0 content-start gap-2 rounded-2xl border border-base-300 bg-base-content/[0.03] p-3 transition-colors data-[over=true]:border-primary data-[over=true]:border-dashed data-[over=true]:bg-primary/10',
      ),
      h.DataAttribute(
        'over',
        Option.contains(model.maybeDragOverBoard, board.key) ? 'true' : 'false',
      ),
      h.AriaLabelledBy(headingId),
      h.OnDragOver(Message.DraggedOverBoard({ board: board.key })),
      h.OnDragLeave(Message.LeftBoardDropZone()),
      h.OnDrop(Message.DroppedOnBoard({ board: board.key })),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-center justify-between gap-2')],
        [
          h.h2(
            [
              h.Id(headingId),
              h.Class('m-0 text-[0.95rem] font-semibold tracking-tight'),
            ],
            [copy.title],
          ),
          h.span(
            [
              h.Class(
                'inline-flex min-w-6 items-center justify-center rounded-full bg-primary/12 px-2 py-0.5 text-[0.72rem] font-semibold text-primary tabular-nums',
              ),
              h.AriaLabel(
                `${localizeDigits(board.count, inputs.display.digits)} کار`,
              ),
            ],
            [localizeDigits(board.count, inputs.display.digits), ' کار'],
          ),
        ],
      ),
      h.p(
        [h.Class('m-0 text-[0.76rem] leading-6 text-base-content/70')],
        [copy.subtitle],
      ),
      board.count === 0
        ? h.p(
            [
              h.Class(
                'm-0 rounded-xl border border-dashed border-base-300 px-3 py-6 text-center text-[0.82rem] leading-7 text-base-content/70',
              ),
            ],
            [copy.empty],
          )
        : h.div(
            [h.Class('grid min-w-0 gap-2')],
            Array.map(groups, group =>
              h.keyed('div')(
                group.key,
                [h.Class('grid min-w-0 gap-1.5')],
                [
                  group.key === 'today' || group.key === 'noDate'
                    ? h.empty
                    : h.h3(
                        [
                          h.Class(
                            'mt-1 mb-0 text-[0.78rem] font-medium text-base-content/70',
                          ),
                        ],
                        [GROUP_TITLES[group.key]],
                      ),
                  h.ul(
                    [h.Class('m-0 grid min-w-0 list-none gap-2 p-0')],
                    Array.map(group.tasks, task =>
                      taskCardView(model, inputs, view, task, h),
                    ),
                  ),
                ],
              ),
            ),
          ),
    ],
  )
}

// COMPLETION HISTORY

const historyView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const digits = inputs.display.digits
  const timeZone = validTimeZone(inputs.display.timeZone)

  const completions = recentCompletions(
    inputs.mirror.tasks,
    new Date(model.now).toISOString(),
  )

  return h.section(
    [h.Class('panel px-4 py-2')],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaExpanded(model.isHistoryOpen),
          h.Class(
            'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg text-start text-[0.9rem] transition-colors hover:text-primary',
          ),
          h.OnClick(Message.ClickedToggleHistory()),
        ],
        [
          h.span([], ['تاریخچهٔ انجام']),
          h.span(
            [
              h.Class(
                'inline-flex min-w-6 items-center justify-center rounded-full bg-primary/12 px-2 py-0.5 text-[0.72rem] font-semibold text-primary tabular-nums',
              ),
            ],
            [localizeDigits(completions.length, digits)],
          ),
          h.span(
            [
              h.Class(
                'ms-auto text-base-content/70 transition-transform data-[open=true]:rotate-180',
              ),
              h.DataAttribute('open', model.isHistoryOpen ? 'true' : 'false'),
            ],
            [chevronDownIcon('size-4')],
          ),
        ],
      ),
      h.div(
        [h.Class(model.isHistoryOpen ? 'grid gap-1' : 'hidden')],
        [
          h.p(
            [
              h.Class(
                'mt-1 mb-2 text-[0.76rem] leading-6 text-base-content/70',
              ),
            ],
            ['تا هفت روز قابل بازگردانی است؛ پس از آن بایگانی می‌شود.'],
          ),
          Array.match(completions, {
            onEmpty: () =>
              h.p(
                [h.Class(QUIET_CLASS)],
                ['هنوز کاری در این هفته انجام نشده است.'],
              ),
            onNonEmpty: rows =>
              h.ul(
                [h.Class('m-0 grid list-none gap-1 p-0')],
                Array.map(rows, task =>
                  h.keyed('li')(
                    task.id,
                    [
                      h.Class(
                        'flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-base-300 py-2',
                      ),
                    ],
                    [
                      h.p(
                        [
                          h.Class(
                            'm-0 min-w-0 flex-1 text-[0.85rem] text-base-content/70 line-through wrap-anywhere',
                          ),
                        ],
                        [task.title],
                      ),
                      h.span(
                        [h.Class('text-[0.72rem] text-base-content/70')],
                        [
                          task.completedAt === null
                            ? ''
                            : formatCompletionTime(
                                task.completedAt,
                                timeZone,
                                digits,
                              ),
                        ],
                      ),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class(
                            'min-h-10 flex-none rounded-full px-3 text-[0.76rem] text-base-content/70 transition-colors hover:bg-base-content/5 hover:text-primary sm:min-h-8',
                          ),
                          h.AriaLabel(`بازگرداندن ${task.title}`),
                          h.OnClick(
                            Message.ClickedRestoreCompletion({
                              taskId: task.id,
                              title: task.title,
                              maybeStartedAt: Option.fromNullishOr(
                                task.startedAt,
                              ),
                            }),
                          ),
                        ],
                        ['بازگرداندن'],
                      ),
                    ],
                  ),
                ),
              ),
          }),
        ],
      ),
    ],
  )
}

// PAGE

const toastView = (
  maybeToast: Option.Option<TaskToast>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeToast, {
    onNone: () => h.empty,
    onSome: toast =>
      h.div(
        [
          h.Class(
            'fixed inset-x-3 bottom-[5.5rem] z-40 mx-auto flex max-w-[420px] items-center justify-between gap-3 rounded-2xl border border-base-300 bg-base-100 py-2.5 ps-4 pe-3 text-base-content shadow-float sm:bottom-4',
          ),
          h.Role('status'),
          h.AriaLive('polite'),
        ],
        [
          h.p(
            [h.Class('m-0 text-[0.85rem] leading-7 wrap-anywhere')],
            [`انجام شد: ${toast.title}`],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class(
                'min-h-10 flex-none rounded-full border border-base-300 px-3.5 text-[0.8rem] text-base-content/75 transition-colors hover:bg-base-content/5 hover:text-base-content sm:min-h-9',
              ),
              h.OnClick(
                Message.ClickedUndoToast({ generation: toast.generation }),
              ),
            ],
            ['بازگرداندن'],
          ),
        ],
      ),
  })

const headerView = (inputs: ViewInputs, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('grid gap-2')],
    [
      h.h1(
        [h.Class('m-0 text-2xl font-bold tracking-tight sm:text-3xl')],
        ['کارها'],
      ),
      h.p(
        [h.Class('m-0 text-sm leading-7 text-base-content/70')],
        [
          'هر تغییر اول روی همین دستگاه ذخیره می‌شود؛ بعد در پس‌زمینه همگام می‌شود.',
        ],
      ),
      inputs.isOnline
        ? h.empty
        : h.p(
            [
              h.Role('status'),
              h.Class('notice notice-warning m-0 text-[0.8rem] leading-7'),
            ],
            [
              'آفلاین هستید: ساخت، جابه‌جایی و انجام‌دادن کار می‌کند و بعداً ارسال می‌شود.',
            ],
          ),
      inputs.pending > 0
        ? h.p(
            [
              h.Role('status'),
              h.AriaLive('polite'),
              h.Class('m-0 text-[0.78rem] leading-6 text-base-content/70'),
            ],
            [
              `${localizeDigits(inputs.pending, inputs.display.digits)} تغییر در صف همگام‌سازی است.`,
            ],
          )
        : h.empty,
    ],
  )

export const tasksPageView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const view = viewOf(model, inputs)

  return h.div(
    [
      h.Class('overflow-x-clip bg-base-200 text-base-content'),
      h.Dir('rtl'),
      h.Lang('fa'),
    ],
    [
      h.div(
        [
          h.Class(
            'page-wrap grid grid-cols-1 min-w-0 max-w-7xl gap-4 lg:grid-cols-[264px_minmax(0,1fr)] lg:items-start',
          ),
        ],
        [
          h.div(
            [h.Class('flex min-w-0 lg:hidden')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class(
                    'inline-flex min-h-10 items-center gap-1.5 rounded-full border border-base-300 bg-base-100 px-4 py-1.5 text-[0.85rem] text-base-content transition-colors hover:border-base-content/20 aria-expanded:border-primary aria-expanded:bg-primary/10 aria-expanded:text-primary',
                  ),
                  h.AriaExpanded(model.isFiltersOpen),
                  h.AriaControls('tasks-filter-panel'),
                  h.OnClick(Message.ClickedToggleFilters()),
                ],
                ['فیلترها و پروژه‌ها'],
              ),
            ],
          ),
          h.aside(
            [
              h.Id('tasks-filter-panel'),
              h.Class(
                'hidden min-w-0 data-[open=true]:grid lg:sticky lg:top-[84px] lg:col-start-1 lg:row-start-1 lg:grid',
              ),
              h.DataAttribute('open', model.isFiltersOpen ? 'true' : 'false'),
              h.AriaLabel('فیلتر کارها'),
            ],
            [filterPanelView(model, inputs, view, h)],
          ),
          h.div(
            [h.Class('grid min-w-0 gap-4 lg:col-start-2 lg:row-start-1')],
            [
              headerView(inputs, h),
              quickAddView(model, inputs, view, h),
              Option.match(model.maybeError, {
                onNone: () => h.empty,
                onSome: message =>
                  h.p(
                    [
                      h.Role('alert'),
                      h.Class('notice notice-error m-0 text-sm leading-7'),
                    ],
                    [message],
                  ),
              }),
              inputs.isStoreReady
                ? h.div(
                    [],
                    [
                      h.div(
                        [
                          h.Class(
                            'grid min-w-0 gap-4 lg:grid-cols-3 lg:items-start',
                          ),
                        ],
                        [
                          boardView(model, inputs, view, view.today, h),
                          boardView(model, inputs, view, view.upcoming, h),
                          boardView(model, inputs, view, view.inbox, h),
                        ],
                      ),
                      historyView(model, inputs, h),
                    ],
                  )
                : h.p(
                    [
                      h.Class(
                        'm-0 flex items-center gap-2 text-sm text-base-content/70',
                      ),
                    ],
                    [
                      h.span([
                        h.AriaHidden(true),
                        h.Class('spinner spinner-sm'),
                      ]),
                      'در حال آماده‌سازی حافظه‌ی محلی…',
                    ],
                  ),
            ],
          ),
        ],
      ),
      h.p(
        [h.Class('sr-only'), h.Role('status'), h.AriaLive('polite')],
        [model.announcement],
      ),
      pickerDialogView(
        {
          model: model.picker,
          toParentMessage: message => Message.GotPickerMessage({ message }),
          digits: inputs.display.digits,
          weekStart: inputs.display.weekStart,
        },
        h,
      ),
      toastView(model.maybeToast, h),
    ],
  )
}
