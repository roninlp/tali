import { Html, inertHtml as ih } from 'foldkit/html'

const strokeIcon = (className: string, children: ReadonlyArray<Html>): Html =>
  ih.svg(
    [
      ih.Class(className),
      ih.AriaHidden(true),
      ih.Xmlns('http://www.w3.org/2000/svg'),
      ih.Fill('none'),
      ih.ViewBox('0 0 24 24'),
      ih.StrokeWidth('1.75'),
      ih.Stroke('currentColor'),
    ],
    children,
  )

const roundCaps = () => [ih.StrokeLinecap('round'), ih.StrokeLinejoin('round')]

export const sunIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.circle([ih.Cx('12'), ih.Cy('12'), ih.R('4')]),
    ih.path([
      ...roundCaps(),
      ih.D(
        'M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
      ),
    ]),
  ])

export const moonIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.path([
      ...roundCaps(),
      ih.D('M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z'),
    ]),
  ])

export const todayIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.rect([
      ih.X('3'),
      ih.Y('4'),
      ih.Width('18'),
      ih.Height('17'),
      ih.Rx('3'),
    ]),
    ih.path([...roundCaps(), ih.D('M8 2v4M16 2v4M3 10h18M8 14h3M8 17h6')]),
  ])

export const calendarIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.rect([
      ih.X('3'),
      ih.Y('4'),
      ih.Width('18'),
      ih.Height('17'),
      ih.Rx('3'),
    ]),
    ih.path([...roundCaps(), ih.D('M8 2v4M16 2v4M3 10h18')]),
  ])

export const tasksIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.rect([
      ih.X('3'),
      ih.Y('3'),
      ih.Width('18'),
      ih.Height('18'),
      ih.Rx('4'),
    ]),
    ih.path([...roundCaps(), ih.D('m8 12 2.5 2.5L16 9')]),
  ])

export const habitsIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.path([...roundCaps(), ih.D('M17 2l4 4-4 4')]),
    ih.path([...roundCaps(), ih.D('M3 11v-1a4 4 0 0 1 4-4h14')]),
    ih.path([...roundCaps(), ih.D('M7 22l-4-4 4-4')]),
    ih.path([...roundCaps(), ih.D('M21 13v1a4 4 0 0 1-4 4H3')]),
  ])

export const listsIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.path([...roundCaps(), ih.D('M8 6h13M8 12h13M8 18h13')]),
    ih.path([...roundCaps(), ih.D('M3 6h.01M3 12h.01M3 18h.01')]),
  ])

export const notesIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.path([...roundCaps(), ih.D('M6 2h9l5 5v15H6z')]),
    ih.path([...roundCaps(), ih.D('M15 2v5h5M9 12h8M9 16h6')]),
  ])

export const remindersIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.path([
      ...roundCaps(),
      ih.D('M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9'),
    ]),
    ih.path([...roundCaps(), ih.D('M10 21h4')]),
  ])

export const settingsIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.circle([ih.Cx('12'), ih.Cy('12'), ih.R('3')]),
    ih.path([
      ...roundCaps(),
      ih.D(
        'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.31a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.69 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.69h.08A1.7 1.7 0 0 0 10.08 3.14V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.31 9v.08a1.7 1.7 0 0 0 1.55 1h.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z',
      ),
    ]),
  ])

export const searchIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.circle([ih.Cx('11'), ih.Cy('11'), ih.R('7')]),
    ih.path([...roundCaps(), ih.D('m20 20-3.5-3.5')]),
  ])

export const sparklesIcon = (className: string): Html =>
  strokeIcon(className, [
    ih.path([
      ...roundCaps(),
      ih.D('M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z'),
    ]),
    ih.path([
      ...roundCaps(),
      ih.D('M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z'),
    ]),
  ])
