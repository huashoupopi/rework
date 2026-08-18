import * as React from "react"
export function PagePlaceholder({ description, title }) {
  return (
    <section>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </section>
  )
}
