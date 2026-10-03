/** Strip a leading YAML frontmatter block from an imported role document. */
export function roleInstructions(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
