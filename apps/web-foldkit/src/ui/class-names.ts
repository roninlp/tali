/** Joins the class strings that apply, dropping the ones that do not. */
export const classNames = (
  ...values: ReadonlyArray<string | undefined>
): string =>
  values.filter(value => value !== undefined && value !== '').join(' ')
