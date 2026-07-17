package com.dbx.agent;

import java.util.List;

public final class CompletionAssistantResponse {
    private final List<CompletionAssistantCandidate> candidates;
    private final boolean incomplete;
    private final boolean fallback_used;

    public CompletionAssistantResponse(List<CompletionAssistantCandidate> candidates, boolean incomplete, boolean fallbackUsed) {
        this.candidates = candidates;
        this.incomplete = incomplete;
        this.fallback_used = fallbackUsed;
    }

    public List<CompletionAssistantCandidate> getCandidates() { return candidates; }
    public boolean getIncomplete() { return incomplete; }
    public boolean getFallback_used() { return fallback_used; }
}
