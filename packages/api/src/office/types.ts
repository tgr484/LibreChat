/** A bullet list with an optional heading, used by both columns of `two_columns`. */
export interface PresentationColumn {
  heading?: string;
  bullets: string[];
}

export interface PresentationTable {
  header: string[];
  rows: string[][];
}

export type PresentationLayout = 'bullets' | 'section' | 'two_columns' | 'table';

export interface PresentationSlide {
  layout?: PresentationLayout;
  title: string;
  bullets?: string[];
  left?: PresentationColumn;
  right?: PresentationColumn;
  table?: PresentationTable;
  /** Speaker notes; never shown on the slide itself. */
  notes?: string;
  /** Citations such as `№3 «Испытания турбодетандера», с. 41`, printed in the slide footer. */
  sources?: string[];
}

/** What the model passes to `create_presentation`. */
export interface PresentationSpec {
  title: string;
  subtitle?: string;
  slides: PresentationSlide[];
  filename?: string;
}
