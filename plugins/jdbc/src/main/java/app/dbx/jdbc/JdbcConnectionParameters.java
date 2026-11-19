package app.dbx.jdbc;

import java.sql.Driver;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/** Reads JDBC property metadata without opening or modifying a database connection. */
public final class JdbcConnectionParameters {
    private JdbcConnectionParameters() {}

    public static List<Map<String, Object>> describe(Driver driver, String url, Properties properties) throws SQLException {
        DriverPropertyInfo[] information = driver.getPropertyInfo(url, properties);
        List<Map<String, Object>> result = new ArrayList<>();
        if (information == null) return result;
        for (DriverPropertyInfo property : information) {
            if (property == null || property.name == null || property.name.isBlank()) continue;
            String name = property.name.toLowerCase(Locale.ROOT);
            // Authentication already has dedicated fields in the connection form.
            if (name.equals("user") || name.equals("username") || name.equals("password")) continue;
            boolean secret = name.matches(".*(password|passwd|pwd|token|secret|credential|private.?key|pvt.?key|access.?key|api.?key).*");
            Map<String, Object> definition = new LinkedHashMap<>();
            definition.put("name", property.name);
            definition.put("description", property.description == null ? "" : property.description);
            definition.put("required", property.required);
            definition.put("secret", secret);
            definition.put("source", "driver");
            List<String> choices = property.choices == null || secret ? List.of()
                : Arrays.stream(property.choices).filter(value -> value != null).distinct().toList();
            boolean booleanChoices = choices.size() == 2 && choices.stream().allMatch(value -> value.equalsIgnoreCase("true") || value.equalsIgnoreCase("false"));
            definition.put("type", booleanChoices ? "boolean" : choices.isEmpty() ? "string" : "enum");
            if (!choices.isEmpty()) definition.put("choices", choices);
            // Drivers can echo supplied credentials as "defaults". Never send them to a client.
            if (property.value != null && !secret) definition.put("defaultValue", property.value);
            result.add(definition);
        }
        return result;
    }
}
