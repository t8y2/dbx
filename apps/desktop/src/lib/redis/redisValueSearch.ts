/** Compatibility exports for Redis STRING value Ctrl+F. */
import { TEXT_CONTENT_SEARCH_FULL_HIGHLIGHT_MAX_CHARS, TEXT_CONTENT_SEARCH_MATCH_LIMIT, canFullHighlightTextContent, findTextContentMatches, nextTextContentSearchMatchIndex, renderTextContentSearchHtml, textContentSearchStatus, type TextContentMatch } from "@/lib/common/textContentSearch";

export const REDIS_VALUE_SEARCH_MATCH_LIMIT = TEXT_CONTENT_SEARCH_MATCH_LIMIT;
export const REDIS_VALUE_SEARCH_FULL_HIGHLIGHT_MAX_CHARS = TEXT_CONTENT_SEARCH_FULL_HIGHLIGHT_MAX_CHARS;
export type RedisTextMatch = TextContentMatch;
export const findRedisTextMatches = findTextContentMatches;
export const redisValueSearchStatus = textContentSearchStatus;
export const nextRedisSearchMatchIndex = nextTextContentSearchMatchIndex;
export const canFullHighlightRedisText = canFullHighlightTextContent;
export const renderRedisTextSearchHtml = renderTextContentSearchHtml;
export { isTextContentSearchDragSource } from "@/lib/common/textContentSearch";
