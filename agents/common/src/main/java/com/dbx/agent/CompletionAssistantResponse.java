package com.dbx.agent;

import java.util.List;

public final class CompletionAssistantResponse {
    private final List<CompletionAssistantCandidate> candidates;
    private final boolean incomplete;
    private final boolean fallback_used;
    private final Boolean routine_search_supported;

    public CompletionAssistantResponse(List<CompletionAssistantCandidate> candidates, boolean incomplete, boolean fallbackUsed) {
        this(candidates, incomplete, fallbackUsed, null);
    }

    public CompletionAssistantResponse(List<CompletionAssistantCandidate> candidates, boolean incomplete, boolean fallbackUsed, Boolean routineSearchSupported) {
        this.candidates = candidates;
        this.incomplete = incomplete;
        this.fallback_used = fallbackUsed;
        this.routine_search_supported = routineSearchSupported;
    }

    public List<CompletionAssistantCandidate> getCandidates() { return candidates; }
    public boolean getIncomplete() { return incomplete; }
    public boolean getFallback_used() { return fallback_used; }
}
