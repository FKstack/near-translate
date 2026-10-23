export interface ReadingOutlineItem {
  id: string;
  text: string;
  level: number;
}

/** A detached, sanitized snapshot. The reader owner releases it on close. */
export interface ReadingArticle {
  title: string;
  byline: string;
  siteName: string;
  sourceUrl: string;
  lang: string;
  excerpt: string;
  wordCount: number;
  readingMinutes: number;
  content: HTMLElement;
  outline: ReadingOutlineItem[];
  strategy: 'readability' | 'semantic';
  truncated: boolean;
  /** Keys match data-near-reader-source; values remain owned by the website. */
  sourceMap: ReadonlyMap<string, Element>;
}
