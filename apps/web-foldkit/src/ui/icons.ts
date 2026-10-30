import { Html, inertHtml as ih } from 'foldkit/html'

const strokeIcon = (className: string, children: ReadonlyArray<Html>): Html =>
  ih.svg(
    [
      ih.Class(className),
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
