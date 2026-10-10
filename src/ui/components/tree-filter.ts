export interface TreeFilterEntry<Node extends { hidden: boolean | string }> {
  node: Node;
  parent: Node | null;
  text: string;
  completed: boolean;
}

// Entries are in preorder, so children propagate visibility to parents in one reverse pass.
export function filterTree<Node extends { hidden: boolean | string }>(entries: TreeFilterEntry<Node>[], term: string): void {
  const visibleParents = new Set<Node>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const visible = term
      ? entry.text.includes(term) || visibleParents.has(entry.node)
      : !entry.completed || visibleParents.has(entry.node);
    entry.node.hidden = !visible;
    if (visible && entry.parent) visibleParents.add(entry.parent);
  }
}
