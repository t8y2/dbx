package com.dbx.agent;

import java.util.Objects;

public final class TriggerInfo {
    private String name;
    private String event;
    private String timing;

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

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof TriggerInfo)) return false;
        TriggerInfo that = (TriggerInfo) other;
        return Objects.equals(name, that.name)
            && Objects.equals(event, that.event)
            && Objects.equals(timing, that.timing);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, event, timing);
    }

    @Override
    public String toString() {
        return "TriggerInfo(name=" + name + ", event=" + event + ", timing=" + timing + ")";
    }
}
