package main

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const oracleJDBCThinPrefix = "jdbc:oracle:thin:@"

type oracleTNSConfig struct {
	Alias    string
	TNSAdmin string
}

func buildDSNForConnect(params connectParams) (string, error) {
	config, ok, err := parseOracleTNSJDBCURL(params.ConnectionString)
	if err != nil {
		return "", err
	}
	if !ok {
		return buildDSN(params), nil
	}

	descriptor, err := resolveOracleTNSAlias(config)
	if err != nil {
		return "", err
	}
	options := parseURLParams(params.URLParams)
	if params.SysDBA {
		options["AUTH TYPE"] = "SYSDBA"
	}
	return buildGoOraJDBC(params.Username, params.Password, descriptor, options), nil
}

func parseOracleTNSJDBCURL(value string) (oracleTNSConfig, bool, error) {
	source := strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(source), oracleJDBCThinPrefix) {
		return oracleTNSConfig{}, false, nil
	}

	target := strings.TrimSpace(source[len(oracleJDBCThinPrefix):])
	if target == "" || strings.HasPrefix(target, "(") || strings.HasPrefix(target, "//") || strings.Contains(strings.SplitN(target, "?", 2)[0], ":") {
		return oracleTNSConfig{}, false, nil
	}

	parts := strings.SplitN(target, "?", 2)
	alias, err := url.QueryUnescape(strings.TrimSpace(parts[0]))
	if err != nil || strings.TrimSpace(alias) == "" {
		return oracleTNSConfig{}, true, fmt.Errorf("Oracle TNS network alias is invalid")
	}
	if len(parts) == 1 {
		return oracleTNSConfig{}, true, fmt.Errorf("Oracle TNS_ADMIN directory is required")
	}
	query, err := url.ParseQuery(parts[1])
	if err != nil {
		return oracleTNSConfig{}, true, fmt.Errorf("Oracle TNS connection parameters are invalid: %w", err)
	}
	tnsAdmin := strings.TrimSpace(query.Get("TNS_ADMIN"))
	if tnsAdmin == "" {
		return oracleTNSConfig{}, true, fmt.Errorf("Oracle TNS_ADMIN directory is required")
	}
	return oracleTNSConfig{Alias: strings.TrimSpace(alias), TNSAdmin: tnsAdmin}, true, nil
}

func resolveOracleTNSAlias(config oracleTNSConfig) (string, error) {
	tnsNamesPath, err := oracleTNSNamesPath(config.TNSAdmin)
	if err != nil {
		return "", err
	}
	aliases, err := readOracleTNSAliases(tnsNamesPath, make(map[string]bool), 0)
	if err != nil {
		return "", err
	}
	descriptor, ok := aliases[strings.ToUpper(config.Alias)]
	if !ok {
		return "", fmt.Errorf("Oracle TNS alias %q was not found in %s", config.Alias, tnsNamesPath)
	}
	return descriptor, nil
}

func oracleTNSNamesPath(tnsAdmin string) (string, error) {
	path := filepath.Clean(strings.TrimSpace(tnsAdmin))
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("Oracle TNS_ADMIN directory is not accessible: %s", path)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("Oracle TNS_ADMIN must be a directory containing tnsnames.ora: %s", path)
	}
	tnsNamesPath := filepath.Join(path, "tnsnames.ora")
	if info, err := os.Stat(tnsNamesPath); err != nil || info.IsDir() {
		return "", fmt.Errorf("Oracle tnsnames.ora was not found in TNS_ADMIN directory: %s", path)
	}
	return tnsNamesPath, nil
}

func readOracleTNSAliases(path string, visited map[string]bool, depth int) (map[string]string, error) {
	if depth > 8 {
		return nil, fmt.Errorf("Oracle TNS include depth exceeds 8 files")
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("Failed to resolve Oracle TNS file path: %w", err)
	}
	if visited[absolutePath] {
		return map[string]string{}, nil
	}
	visited[absolutePath] = true

	file, err := os.Open(absolutePath)
	if err != nil {
		return nil, fmt.Errorf("Failed to read Oracle TNS file %s: %w", absolutePath, err)
	}
	defer file.Close()

	aliases := make(map[string]string)
	var currentAliases []string
	var description strings.Builder
	descriptionStarted := false
	parenthesisDepth := 0
	flush := func() {
		if len(currentAliases) == 0 {
			return
		}
		value := strings.Join(strings.Fields(description.String()), " ")
		if value != "" {
			for _, alias := range currentAliases {
				alias = strings.ToUpper(strings.TrimSpace(alias))
				if alias != "" {
					aliases[alias] = value
				}
			}
		}
		currentAliases = nil
		description.Reset()
		descriptionStarted = false
		parenthesisDepth = 0
	}

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		trimmed := strings.TrimSpace(stripOracleTNSComment(scanner.Text()))
		if trimmed == "" {
			continue
		}
		if len(currentAliases) == 0 {
			if divider := strings.Index(trimmed, "="); divider >= 0 {
				key := strings.TrimSpace(trimmed[:divider])
				value := strings.TrimSpace(trimmed[divider+1:])
				if strings.EqualFold(key, "IFILE") {
					includePath := strings.Trim(value, "\"'")
					if !filepath.IsAbs(includePath) {
						includePath = filepath.Join(filepath.Dir(absolutePath), includePath)
					}
					included, includeErr := readOracleTNSAliases(includePath, visited, depth+1)
					if includeErr != nil {
						return nil, includeErr
					}
					for alias, descriptor := range included {
						aliases[alias] = descriptor
					}
					continue
				}
				currentAliases = strings.Split(key, ",")
				if value != "" {
					descriptionStarted = true
					description.WriteString(value)
					parenthesisDepth += oracleTNSParenthesisDelta(value)
				}
			}
		} else {
			description.WriteByte(' ')
			description.WriteString(trimmed)
			descriptionStarted = true
			parenthesisDepth += oracleTNSParenthesisDelta(trimmed)
		}
		if len(currentAliases) > 0 && descriptionStarted && parenthesisDepth <= 0 {
			flush()
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("Failed to read Oracle TNS file %s: %w", absolutePath, err)
	}
	flush()
	return aliases, nil
}

func stripOracleTNSComment(line string) string {
	var quote rune
	for index, char := range line {
		switch {
		case quote != 0 && char == quote:
			quote = 0
		case quote == 0 && (char == '\'' || char == '"'):
			quote = char
		case quote == 0 && char == '#':
			return line[:index]
		}
	}
	return line
}

func oracleTNSParenthesisDelta(value string) int {
	delta := 0
	var quote rune
	for _, char := range value {
		switch {
		case quote != 0 && char == quote:
			quote = 0
		case quote == 0 && (char == '\'' || char == '"'):
			quote = char
		case quote == 0 && char == '(':
			delta++
		case quote == 0 && char == ')':
			delta--
		}
	}
	return delta
}
