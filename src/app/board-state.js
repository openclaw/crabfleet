export function visibleBoardCards(cards, { filter, current, query }) {
  return cards.filter((card) => {
    if (filter === "mine" && card.owner !== current) return false;
    if (filter === "hot" && card.lane !== "Running") return false;
    return matchesCard(card, query);
  });
}

export function matchesCard(card, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const changedPaths = (card.changes?.files || []).map((file) => file.path).join(" ");
  return [card.id, card.title, card.repo, card.source, card.runtime, card.policy, changedPaths]
    .join(" ")
    .toLowerCase()
    .includes(normalizedQuery);
}
