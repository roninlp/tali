import { Array, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { localizeDigits } from '@tali/domain'
import type { Digits, TaskBucketBounds } from '@tali/domain'

import type { ProjectRow, TagRow, TaskRow } from '../mirror'
import { taskKey } from '../mirror'
import { buttonView } from '../ui/button'
import { fieldView, selectInputView } from '../ui/field'
import { Message } from './tasks'
import type {
  Model,
  QuickAddDraft,
  TaskEditor,
  TaskToast,
  ViewInputs,
} from './tasks'
import { quickAddDue } from './tasks'
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
  dateFilterOf,
  dueLabel,
  formatCompletionTime,
  formatLocalDate,
  liveTasks,
  noProjectCountOf,
  priorityFilterOf,
  priorityLabel,
  priorityOf,
  projectCountsOf,
  projectOf,
  recentCompletions,
  shiftLocalDate,
  sortFieldOf,
  statusFilterOf,
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
          h.Class('tasks-tag'),
          h.Style(style),
          h.DataAttribute('selected', 'false'),
        ],
        [tag.name],
      ),
    onSome: onClick =>
      h.button(
        [
          h.Type('button'),
          h.Class('tasks-tag'),
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
      h.Class('tasks-chip'),
      ...(tone === undefined ? [] : [h.DataAttribute('tone', tone)]),
      ...(title === undefined ? [] : [h.Title(title)]),
    ],
    [label],
  )

const projectOptions = (
  projects: ReadonlyArray<ProjectRow>,
  noneLabel: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.option([h.Value('')], [noneLabel]),
  ...Array.map(projects, project =>
    h.option([h.Value(project.id)], [project.title]),
  ),
]

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
    onSome: panel =>
      panel === 'due'
        ? h.div(
            [h.Id('tasks-quick-add-due'), h.Class('tasks-quick-panel')],
            [
              h.div(
                [
                  h.Role('group'),
                  h.AriaLabel('موعد'),
                  h.Class('tasks-chip-row'),
                ],
                Array.map(duePresets, option => {
                  const isActive =
                    dueValue === Option.getOrElse(option.value, () => '')

                  return h.button(
                    [
                      h.Type('button'),
                      h.Class('tasks-pill'),
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
              h.label(
                [h.Class('tasks-field')],
                [
                  h.span([], ['تاریخ دلخواه']),
                  h.input([
                    h.Type('date'),
                    h.AriaLabel('تاریخ موعد'),
                    h.Class('tasks-input'),
                    h.Value(dueValue),
                    h.OnInput(value =>
                      Message.UpdatedQuickAddDueDate({ value }),
                    ),
                  ]),
                ],
              ),
            ],
          )
        : panel === 'priority'
          ? h.div(
              [h.Id('tasks-quick-add-priority'), h.Class('tasks-quick-panel')],
              [
                h.div(
                  [
                    h.Role('group'),
                    h.AriaLabel('اولویت'),
                    h.Class('tasks-chip-row'),
                  ],
                  Array.map(PRIORITY_CHOICES, choice =>
                    h.button(
                      [
                        h.Type('button'),
                        h.Class('tasks-pill'),
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
          : panel === 'tags'
            ? h.div(
                [h.Id('tasks-quick-add-tags'), h.Class('tasks-quick-panel')],
                [
                  Array.match(inputs.mirror.tags, {
                    onEmpty: () =>
                      h.p([h.Class('tasks-quiet')], ['هنوز برچسبی ندارید.']),
                    onNonEmpty: tags =>
                      h.div(
                        [h.Class('tasks-chip-row')],
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
                    [h.Class('tasks-inline-create')],
                    [
                      h.input([
                        h.Type('text'),
                        h.AriaLabel('نام برچسب تازه'),
                        h.Placeholder('برچسب تازه…'),
                        h.Class('tasks-input'),
                        h.Disabled(!inputs.isStoreReady),
                        h.Value(draft.newTagName),
                        h.OnInput(value =>
                          Message.UpdatedQuickAddNewTag({ value }),
                        ),
                        h.OnKeyDownPreventDefault(key =>
                          key === 'Enter'
                            ? Option.some(
                                Message.SubmittedQuickAddTag({
                                  name: draft.newTagName,
                                }),
                              )
                            : Option.none(),
                        ),
                      ]),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class('tasks-pill'),
                          h.Disabled(
                            !inputs.isStoreReady ||
                              draft.newTagName.trim() === '',
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
            : h.div(
                [h.Id('tasks-quick-add-project'), h.Class('tasks-quick-panel')],
                [
                  h.label(
                    [h.Class('tasks-field')],
                    [
                      h.span([], ['پروژه']),
                      h.select(
                        [
                          h.AriaLabel('پروژه'),
                          h.Class('tasks-select'),
                          h.Value(
                            Option.getOrElse(draft.maybeProjectId, () => ''),
                          ),
                          h.OnChange(value =>
                            Message.SelectedQuickAddProject({
                              maybeProjectId:
                                value === ''
                                  ? Option.none()
                                  : Option.some(value),
                            }),
                          ),
                        ],
                        projectOptions(inputs.mirror.projects, 'بدون پروژه', h),
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class('tasks-inline-create')],
                    [
                      h.input([
                        h.Type('text'),
                        h.AriaLabel('نام پروژه‌ی تازه'),
                        h.Placeholder('پروژه‌ی تازه…'),
                        h.Class('tasks-input'),
                        h.Disabled(!inputs.isStoreReady),
                        h.Value(draft.newProjectTitle),
                        h.OnInput(value =>
                          Message.UpdatedQuickAddNewProject({ value }),
                        ),
                        h.OnKeyDownPreventDefault(key =>
                          key === 'Enter'
                            ? Option.some(
                                Message.SubmittedQuickAddProject({
                                  title: draft.newProjectTitle,
                                }),
                              )
                            : Option.none(),
                        ),
                      ]),
                      h.button(
                        [
                          h.Type('button'),
                          h.Class('tasks-pill'),
                          h.Disabled(
                            !inputs.isStoreReady ||
                              draft.newProjectTitle.trim() === '',
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
              ),
  })
}

const quickAddStatusView = (
  draft: QuickAddDraft,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role('status'), h.AriaLive('polite'), h.Class('tasks-quick-status')],
    [
      Option.match(draft.maybeError, {
        onNone: () =>
          h.span(
            [],
            [
              draft.hasSaved
                ? 'ذخیره شد؛ در صف همگام‌سازی.'
                : 'هر تغییر اول روی همین دستگاه ذخیره می‌شود؛ بی‌نیاز از اینترنت.',
            ],
          ),
        onSome: message => h.span([h.Class('tasks-error-text')], [message]),
      }),
    ],
  )

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
      h.Class('tasks-quick panel'),
      h.OnSubmit(Message.SubmittedQuickAdd()),
    ],
    [
      h.div(
        [h.Class('tasks-quick-row')],
        [
          h.input([
            h.Id('tasks-quick-add'),
            h.Type('text'),
            h.AriaLabel('عنوان کار تازه'),
            h.Placeholder('یک کار تازه… (مثلاً خرید شیر)'),
            h.Class('tasks-input tasks-quick-input'),
            h.Value(draft.title),
            h.Disabled(!inputs.isStoreReady),
            h.OnInput(value => Message.UpdatedQuickAddTitle({ value })),
          ]),
          buttonView(
            {
              type: 'submit',
              isDisabled:
                !inputs.isStoreReady ||
                draft.isAdding ||
                draft.title.trim() === '',
              isLoading: draft.isAdding,
              children: ['افزودن'],
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Role('group'), h.AriaLabel('جزئیات کار'), h.Class('tasks-chip-row')],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('tasks-pill'),
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
              h.Class('tasks-pill'),
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
              h.Class('tasks-pill'),
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
              h.Class('tasks-pill'),
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
      h.Class('tasks-project-button'),
      h.AriaPressed(isSelected ? 'true' : 'false'),
      h.DataAttribute('selected', isSelected ? 'true' : 'false'),
      h.OnClick(onSelect),
    ],
    [
      h.span([h.Class('tasks-project-name')], [label]),
      h.span([h.Class('tasks-project-count')], [localizeDigits(count, digits)]),
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
    [h.Class('tasks-filter-card panel')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class('tasks-filter-close'),
          h.OnClick(Message.ClickedToggleFilters()),
        ],
        ['بستن فیلترها'],
      ),
      h.header(
        [h.Class('tasks-filter-head')],
        [
          h.h2([], ['فیلتر و مرتب‌سازی']),
          h.p(
            [],
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
        [
          h.AriaLabelledBy('tasks-filter-projects'),
          h.Class('tasks-filter-block'),
        ],
        [
          h.h3([h.Id('tasks-filter-projects')], ['پروژه‌ها']),
          h.div(
            [h.Class('tasks-project-list')],
            [
              projectButtonView(
                'همه‌ی کارها',
                live.length,
                model.settings.filters.project._tag === 'All',
                Message.SelectedProjectFilter({ project: ProjectFilter.All() }),
                digits,
                h,
              ),
              ...Array.map(inputs.mirror.projects, project =>
                projectButtonView(
                  project.title,
                  counts.get(project.id) ?? 0,
                  model.settings.filters.project._tag === 'Project' &&
                    model.settings.filters.project.projectId === project.id,
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
                model.settings.filters.project._tag === 'None',
                Message.SelectedProjectFilter({
                  project: ProjectFilter.None(),
                }),
                digits,
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('tasks-inline-create')],
            [
              h.input([
                h.Type('text'),
                h.AriaLabel('نام پروژه‌ی تازه'),
                h.Placeholder('پروژه‌ی تازه…'),
                h.Class('tasks-input'),
                h.Disabled(!inputs.isStoreReady),
                h.Value(model.newProjectTitle),
                h.OnInput(value => Message.UpdatedNewProjectTitle({ value })),
                h.OnKeyDownPreventDefault(key =>
                  key === 'Enter'
                    ? Option.some(
                        Message.SubmittedFilterProject({
                          title: model.newProjectTitle,
                        }),
                      )
                    : Option.none(),
                ),
              ]),
              h.button(
                [
                  h.Type('button'),
                  h.Class('tasks-pill'),
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
        [h.AriaLabelledBy('tasks-filter-tags'), h.Class('tasks-filter-block')],
        [
          h.h3(
            [h.Id('tasks-filter-tags')],
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
            onEmpty: () =>
              h.p([h.Class('tasks-quiet')], ['هنوز برچسبی ندارید.']),
            onNonEmpty: tags =>
              h.div(
                [h.Class('tasks-chip-row')],
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
            [h.Class('tasks-inline-create')],
            [
              h.input([
                h.Type('text'),
                h.AriaLabel('نام برچسب تازه'),
                h.Placeholder('برچسب تازه…'),
                h.Class('tasks-input'),
                h.Disabled(!inputs.isStoreReady),
                h.Value(model.newTagName),
                h.OnInput(value => Message.UpdatedNewTagName({ value })),
                h.OnKeyDownPreventDefault(key =>
                  key === 'Enter'
                    ? Option.some(
                        Message.SubmittedFilterTag({ name: model.newTagName }),
                      )
                    : Option.none(),
                ),
              ]),
              h.button(
                [
                  h.Type('button'),
                  h.Class('tasks-pill'),
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
      fieldView(
        {
          id: 'tasks-filter-priority',
          label: 'اولویت',
          children: [
            selectInputView(
              {
                id: 'tasks-filter-priority',
                value: model.settings.filters.priority,
                options: Array.map(PRIORITY_OPTIONS, option => ({
                  value: option.value,
                  label: option.label,
                })),
                onChange: value =>
                  Message.SelectedPriorityFilter({
                    priority: priorityFilterOf(value),
                  }),
              },
              h,
            ),
          ],
        },
        h,
      ),
      fieldView(
        {
          id: 'tasks-filter-status',
          label: 'وضعیت',
          children: [
            selectInputView(
              {
                id: 'tasks-filter-status',
                value: model.settings.filters.status,
                options: Array.map(STATUS_OPTIONS, option => ({
                  value: option.value,
                  label: option.label,
                })),
                onChange: value =>
                  Message.SelectedStatusFilter({
                    status: statusFilterOf(value),
                  }),
              },
              h,
            ),
          ],
        },
        h,
      ),
      fieldView(
        {
          id: 'tasks-filter-date',
          label: 'زمان',
          children: [
            selectInputView(
              {
                id: 'tasks-filter-date',
                value: model.settings.filters.date,
                options: Array.map(DATE_OPTIONS, option => ({
                  value: option.value,
                  label: option.label,
                })),
                onChange: value =>
                  Message.SelectedDateFilter({ date: dateFilterOf(value) }),
              },
              h,
            ),
          ],
        },
        h,
      ),
      h.div(
        [h.Class('tasks-sort-row')],
        [
          fieldView(
            {
              id: 'tasks-filter-sort',
              label: 'مرتب‌سازی',
              children: [
                selectInputView(
                  {
                    id: 'tasks-filter-sort',
                    value: model.settings.sort.by,
                    options: Array.map(TASK_SORT_FIELDS, field => ({
                      value: field,
                      label: SORT_FIELD_LABELS[field],
                    })),
                    onChange: value =>
                      Message.SelectedSortField({
                        by: sortFieldOf(value),
                      }),
                  },
                  h,
                ),
              ],
            },
            h,
          ),
          buttonView(
            {
              type: 'button',
              variant: 'outline',
              size: 'sm',
              class: 'tasks-sort-direction',
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
              h.Class('tasks-pill'),
              h.OnClick(Message.ClickedClearFilters()),
            ],
            [`پاک کردن فیلترها (${localizeDigits(active, digits)})`],
          )
        : h.empty,
      h.p(
        [h.Class('tasks-filter-note')],
        ['فیلترها و مرتب‌سازی روی همین دستگاه ذخیره می‌شوند.'],
      ),
    ],
  )
}

// TASK CARD

const moveButton = (
  label: string,
  maybeDueDate: Option.Option<string>,
  task: TaskRow,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class('tasks-move'),
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
  task: TaskRow,
  editor: TaskEditor,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const editorId = `task-${task.id}-editor`

  return h.div(
    [h.Id(editorId), h.Class('tasks-editor')],
    [
      fieldView(
        {
          id: `task-${task.id}-title`,
          label: 'عنوان',
          children: [
            h.input([
              h.Id(`task-${task.id}-title`),
              h.Type('text'),
              h.Class('tasks-input'),
              h.Value(editor.title),
              h.OnInput(value =>
                Message.UpdatedTaskTitle({ taskId: task.id, value }),
              ),
            ]),
          ],
        },
        h,
      ),
      fieldView(
        {
          id: `task-${task.id}-description`,
          label: 'توضیح',
          children: [
            h.textarea([
              h.Id(`task-${task.id}-description`),
              h.Class('tasks-input'),
              h.Rows(3),
              h.Value(editor.description),
              h.OnInput(value =>
                Message.UpdatedTaskDescription({ taskId: task.id, value }),
              ),
            ]),
          ],
        },
        h,
      ),
      h.div(
        [h.Class('tasks-editor-grid')],
        [
          fieldView(
            {
              id: `task-${task.id}-due`,
              label: 'موعد',
              children: [
                h.input([
                  h.Id(`task-${task.id}-due`),
                  h.Type('date'),
                  h.Class('tasks-input'),
                  h.Value(editor.dueDate),
                  h.OnInput(value =>
                    Message.UpdatedTaskDueDate({ taskId: task.id, value }),
                  ),
                ]),
              ],
            },
            h,
          ),
          fieldView(
            {
              id: `task-${task.id}-priority`,
              label: 'اولویت',
              children: [
                selectInputView(
                  {
                    id: `task-${task.id}-priority`,
                    value: task.priority,
                    options: Array.map(PRIORITY_CHOICES, choice => ({
                      value: choice.value,
                      label: choice.label,
                    })),
                    onChange: value =>
                      Message.SelectedTaskPriority({
                        taskId: task.id,
                        priority: priorityOf(value),
                      }),
                  },
                  h,
                ),
              ],
            },
            h,
          ),
          fieldView(
            {
              id: `task-${task.id}-status`,
              label: 'وضعیت',
              children: [
                selectInputView(
                  {
                    id: `task-${task.id}-status`,
                    value: task.status === 'doing' ? 'doing' : 'todo',
                    options: [
                      { value: 'todo', label: STATUS_LABELS.todo },
                      { value: 'doing', label: STATUS_LABELS.doing },
                    ],
                    onChange: value =>
                      Message.SelectedTaskStatus({
                        taskId: task.id,
                        status: value === 'doing' ? 'doing' : 'todo',
                      }),
                  },
                  h,
                ),
              ],
            },
            h,
          ),
          fieldView(
            {
              id: `task-${task.id}-project`,
              label: 'پروژه',
              children: [
                selectInputView(
                  {
                    id: `task-${task.id}-project`,
                    value: task.projectId ?? '',
                    options: [
                      { value: '', label: 'بدون پروژه' },
                      ...Array.map(inputs.mirror.projects, project => ({
                        value: project.id,
                        label: project.title,
                      })),
                    ],
                    onChange: value =>
                      Message.SelectedTaskProject({
                        taskId: task.id,
                        maybeProjectId:
                          value === '' ? Option.none() : Option.some(value),
                      }),
                  },
                  h,
                ),
              ],
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Role('group'), h.AriaLabel('برچسب‌ها'), h.Class('tasks-field')],
        [
          h.span([], ['برچسب‌ها']),
          Array.match(inputs.mirror.tags, {
            onEmpty: () =>
              h.p([h.Class('tasks-quiet')], ['هنوز برچسبی ساخته نشده است.']),
            onNonEmpty: tags =>
              h.div(
                [h.Class('tasks-chip-row')],
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
        [h.Class('tasks-editor-actions')],
        [
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
    [h.Class('tasks-meta')],
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
      h.Class('tasks-moves'),
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
      h.Class('tasks-card'),
      h.DataAttribute('overdue', overdue ? 'true' : 'false'),
      h.DataAttribute(
        'dragging',
        Option.contains(model.maybeDraggingId, task.id) ? 'true' : 'false',
      ),
    ],
    [
      h.div(
        [h.Class('tasks-card-row')],
        [
          h.span(
            [
              h.Draggable(true),
              h.AriaHidden(true),
              h.Title('بکشید تا به روز دیگری برود'),
              h.Class('tasks-drag-handle'),
              h.OnDragStart(Message.StartedTaskDrag({ taskId: task.id })),
              h.OnDragEnd(Message.EndedTaskDrag()),
            ],
            ['⠿'],
          ),
          h.button(
            [
              h.Type('button'),
              h.Class('tasks-check'),
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
              h.Class('tasks-card-title'),
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
        ? h.p([h.Class('tasks-card-description')], [task.description])
        : h.empty,
      taskMetaView(inputs, view, task, h),
      moveActionsView(task, view, h),
      editor !== undefined && editor.saveState !== 'idle'
        ? h.span(
            [
              h.Class('tasks-save-state'),
              h.DataAttribute('state', editor.saveState),
              h.Role('status'),
              h.AriaLive('polite'),
            ],
            [saveLabel],
          )
        : h.empty,
      editor === undefined ? h.empty : editorView(task, editor, inputs, h),
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
      h.Class('tasks-board'),
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
        [h.Class('tasks-board-head')],
        [
          h.h2([h.Id(headingId)], [copy.title]),
          h.span(
            [
              h.Class('tasks-count'),
              h.AriaLabel(
                `${localizeDigits(board.count, inputs.display.digits)} کار`,
              ),
            ],
            [localizeDigits(board.count, inputs.display.digits)],
          ),
        ],
      ),
      h.p([h.Class('tasks-board-sub')], [copy.subtitle]),
      board.count === 0
        ? h.p([h.Class('tasks-board-empty')], [copy.empty])
        : h.div(
            [h.Class('tasks-groups')],
            Array.map(groups, group =>
              h.keyed('div')(
                group.key,
                [h.Class('tasks-group')],
                [
                  group.key === 'today' || group.key === 'noDate'
                    ? h.empty
                    : h.h3(
                        [h.Class('tasks-group-title')],
                        [GROUP_TITLES[group.key]],
                      ),
                  h.ul(
                    [],
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

  return h.details(
    [h.Class('tasks-history')],
    [
      h.summary(
        [],
        [
          h.span([], ['تاریخچهٔ انجام']),
          h.span(
            [h.Class('tasks-count')],
            [localizeDigits(completions.length, digits)],
          ),
        ],
      ),
      h.p(
        [h.Class('tasks-history-hint')],
        ['تا هفت روز قابل بازگردانی است؛ پس از آن بایگانی می‌شود.'],
      ),
      Array.match(completions, {
        onEmpty: () =>
          h.p(
            [h.Class('tasks-quiet')],
            ['هنوز کاری در این هفته انجام نشده است.'],
          ),
        onNonEmpty: rows =>
          h.ul(
            [],
            Array.map(rows, task =>
              h.keyed('li')(
                task.id,
                [],
                [
                  h.p([h.Class('tasks-history-title')], [task.title]),
                  h.span(
                    [h.Class('tasks-history-time')],
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
                      h.Class('tasks-history-restore'),
                      h.AriaLabel(`بازگرداندن ${task.title}`),
                      h.OnClick(
                        Message.ClickedRestoreCompletion({
                          taskId: task.id,
                          title: task.title,
                          maybeStartedAt: Option.fromNullishOr(task.startedAt),
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
        [h.Class('tasks-toast'), h.Role('status'), h.AriaLive('polite')],
        [
          h.p([], [`انجام شد: ${toast.title}`]),
          h.button(
            [
              h.Type('button'),
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
    [h.Class('tasks-head panel')],
    [
      h.h1([], ['کارها']),
      h.p(
        [],
        [
          'هر تغییر اول روی همین دستگاه ذخیره می‌شود؛ بعد در پس‌زمینه همگام می‌شود.',
        ],
      ),
      inputs.isOnline
        ? h.empty
        : h.p(
            [h.Role('status'), h.Class('tasks-offline')],
            [
              'آفلاین هستید: ساخت، جابه‌جایی و انجام‌دادن کار می‌کند و بعداً ارسال می‌شود.',
            ],
          ),
      inputs.pending > 0
        ? h.p(
            [h.Role('status'), h.AriaLive('polite'), h.Class('tasks-pending')],
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
    [h.Class('tasks-root'), h.Dir('rtl'), h.Lang('fa')],
    [
      h.div(
        [h.Class('tasks-layout page-wrap mx-auto max-w-7xl')],
        [
          h.div(
            [h.Class('tasks-filter-toggle-wrap')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class('tasks-filter-toggle'),
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
              h.Class('tasks-filter-panel'),
              h.DataAttribute('open', model.isFiltersOpen ? 'true' : 'false'),
              h.AriaLabel('فیلتر کارها'),
            ],
            [filterPanelView(model, inputs, view, h)],
          ),
          h.div(
            [h.Class('tasks-main')],
            [
              headerView(inputs, h),
              quickAddView(model, inputs, view, h),
              Option.match(model.maybeError, {
                onNone: () => h.empty,
                onSome: message =>
                  h.p([h.Role('alert'), h.Class('tasks-alert')], [message]),
              }),
              inputs.isStoreReady
                ? h.div(
                    [],
                    [
                      h.div(
                        [h.Class('tasks-boards')],
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
                    [h.Class('tasks-loading')],
                    [
                      h.span([
                        h.AriaHidden(true),
                        h.Class('loading loading-spinner loading-sm'),
                      ]),
                      'در حال آماده‌سازی حافظه‌ی محلی…',
                    ],
                  ),
            ],
          ),
        ],
      ),
      h.p(
        [h.Class('tasks-sr'), h.Role('status'), h.AriaLive('polite')],
        [model.announcement],
      ),
      toastView(model.maybeToast, h),
    ],
  )
}
