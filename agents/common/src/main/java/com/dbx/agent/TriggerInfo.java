package com.dbx.agent;

import java.util.Objects;

public final class TriggerInfo {
    private String name;
    private String event;
    private String timing;
    private String statement;
    private String condition;
    private Boolean enabled;
    private Boolean valid;
    private OracleTriggerMetadata oracle_metadata;

    public TriggerInfo() {
        this("", "", "");
    }

    public TriggerInfo(String name, String event, String timing) {
        this.name = name;
        this.event = event;
        this.timing = timing;
    }

    public String getName() {
        return name;
    }

    public String getEvent() {
        return event;
    }

    public String getTiming() {
        return timing;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setEvent(String event) {
        this.event = event;
    }

    public void setTiming(String timing) {
        this.timing = timing;
    }

    public String getStatement() {
        return statement;
    }

    /**
     * Trigger body when the catalog exposes it (Dameng `ALL_TRIGGERS.TRIGGER_BODY`).
     * Callers that cannot read a body leave this null so the JSON payload stays unchanged.
     */
    public void setStatement(String statement) {
        this.statement = statement;
    }

    public String getCondition() {
        return condition;
    }

    /**
     * `WHEN` clause reported by the catalog. A non-empty condition means the structured
     * editor cannot rebuild the trigger without dropping it.
     */
    public void setCondition(String condition) {
        this.condition = condition;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }

    public Boolean getValid() {
        return valid;
    }

    public void setValid(Boolean valid) {
        this.valid = valid;
    }

    public OracleTriggerMetadata getOracle_metadata() {
        return oracle_metadata;
    }

    public void setOracle_metadata(OracleTriggerMetadata metadata) {
        this.oracle_metadata = metadata;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof TriggerInfo)) return false;
        TriggerInfo that = (TriggerInfo) other;
        return Objects.equals(name, that.name)
            && Objects.equals(event, that.event)
            && Objects.equals(timing, that.timing)
            && Objects.equals(statement, that.statement)
            && Objects.equals(condition, that.condition)
            && Objects.equals(enabled, that.enabled)
            && Objects.equals(valid, that.valid)
            && Objects.equals(oracle_metadata, that.oracle_metadata);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, event, timing, statement, condition, enabled, valid, oracle_metadata);
    }

    @Override
    public String toString() {
        return "TriggerInfo(name=" + name + ", event=" + event + ", timing=" + timing + ", enabled=" + enabled + ")";
    }
}
