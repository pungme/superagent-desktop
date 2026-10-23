export function stringifyForPhone(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    typeof field === 'string'
      ? field.replace(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
          '\uFFFD'
        )
      : field
  )
}
