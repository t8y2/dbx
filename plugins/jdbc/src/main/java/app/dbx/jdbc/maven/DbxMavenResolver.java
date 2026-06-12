package app.dbx.jdbc.maven;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.File;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.eclipse.aether.RepositorySystem;
import org.eclipse.aether.RepositorySystemSession;
import org.eclipse.aether.artifact.Artifact;
import org.eclipse.aether.artifact.DefaultArtifact;
import org.eclipse.aether.collection.CollectRequest;
import org.eclipse.aether.graph.Dependency;
import org.eclipse.aether.graph.DependencyNode;
import org.eclipse.aether.repository.LocalRepository;
import org.eclipse.aether.repository.RemoteRepository;
import org.eclipse.aether.resolution.DependencyRequest;
import org.eclipse.aether.resolution.DependencyResult;
import org.eclipse.aether.supplier.RepositorySystemSupplier;
import org.eclipse.aether.supplier.SessionBuilderSupplier;
import org.eclipse.aether.util.artifact.JavaScopes;
import org.eclipse.aether.util.filter.DependencyFilterUtils;

public final class DbxMavenResolver {
    private static final String DEFAULT_REPOSITORY = "https://repo.maven.apache.org/maven2/";
    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    private DbxMavenResolver() {
    }

    public static void main(String[] args) throws Exception {
        try {
            ResolverOptions options = ResolverOptions.parse(args);
            ResolveResult result = resolve(options);
            JSON.writeValue(System.out, result);
            System.out.println();
        } catch (Exception err) {
            Map<String, String> error = new LinkedHashMap<>();
            error.put("error", err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage());
            JSON.writeValue(System.err, error);
            System.err.println();
            System.exit(1);
        }
    }

    private static ResolveResult resolve(ResolverOptions options) throws Exception {
        RepositorySystem system = new RepositorySystemSupplier().get();
        RepositorySystemSession session = new SessionBuilderSupplier(system)
            .get()
            .withLocalRepositories(new LocalRepository(options.localRepository))
            .setRepositoryListener(null)
            .setTransferListener(null)
            .build();

        Artifact rootArtifact = parseCoordinate(options.coordinate);
        Dependency root = new Dependency(rootArtifact, options.scope);
        CollectRequest collect = new CollectRequest();
        collect.setRoot(root);
        for (int index = 0; index < options.repositories.size(); index++) {
            collect.addRepository(new RemoteRepository.Builder("repo-" + index, "default", options.repositories.get(index)).build());
        }

        DependencyRequest request = new DependencyRequest(collect, DependencyFilterUtils.classpathFilter(options.scope));
        DependencyResult dependencyResult = system.resolveDependencies(session, request);
        List<ResolvedArtifact> artifacts = new ArrayList<>();
        collectRuntimeArtifacts(dependencyResult.getRoot(), true, artifacts);
        return new ResolveResult(options.coordinate, options.scope, options.repositories, artifacts);
    }

    private static void collectRuntimeArtifacts(DependencyNode node, boolean root, List<ResolvedArtifact> artifacts) throws Exception {
        Dependency dependency = node.getDependency();
        if (!root && dependency != null && !isRuntimeDependency(dependency)) {
            return;
        }
        Artifact artifact = node.getArtifact();
        if (artifact != null && artifact.getFile() != null) {
            artifacts.add(ResolvedArtifact.from(artifact, artifact.getFile()));
        }
        for (DependencyNode child : node.getChildren()) {
            collectRuntimeArtifacts(child, false, artifacts);
        }
    }

    private static boolean isRuntimeDependency(Dependency dependency) {
        if (dependency.isOptional()) {
            return false;
        }
        String scope = dependency.getScope();
        return scope == null || scope.isBlank() || JavaScopes.COMPILE.equals(scope) || JavaScopes.RUNTIME.equals(scope);
    }

    private static Artifact parseCoordinate(String coordinate) {
        String trimmed = coordinate == null ? "" : coordinate.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("Maven coordinate is required");
        }
        String[] parts = trimmed.split(":");
        if (parts.length == 3) {
            return new DefaultArtifact(parts[0], parts[1], "", "jar", parts[2]);
        }
        if (parts.length == 4) {
            return new DefaultArtifact(parts[0], parts[1], parts[3], "jar", parts[2]);
        }
        if (parts.length == 5) {
            return new DefaultArtifact(parts[0], parts[1], parts[3], parts[2], parts[4]);
        }
        return new DefaultArtifact(trimmed);
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] bytes = java.nio.file.Files.readAllBytes(file.toPath());
        byte[] hash = digest.digest(bytes);
        StringBuilder value = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            value.append(String.format("%02x", b));
        }
        return value.toString();
    }

    private static final class ResolverOptions {
        private String coordinate;
        private String scope = JavaScopes.RUNTIME;
        private Path localRepository = Path.of(System.getProperty("user.home"), ".dbx", "maven");
        private final List<String> repositories = new ArrayList<>();

        private static ResolverOptions parse(String[] args) {
            ResolverOptions options = new ResolverOptions();
            for (int index = 0; index < args.length; index++) {
                String arg = args[index];
                switch (arg) {
                    case "resolve" -> {
                    }
                    case "--coordinate", "-c" -> options.coordinate = value(args, ++index, arg);
                    case "--scope" -> options.scope = value(args, ++index, arg).toLowerCase(Locale.ROOT);
                    case "--repo", "--repository" -> options.repositories.add(value(args, ++index, arg));
                    case "--local-repo" -> options.localRepository = Path.of(value(args, ++index, arg));
                    default -> {
                        if (arg.startsWith("-")) {
                            throw new IllegalArgumentException("Unsupported option: " + arg);
                        }
                        if (options.coordinate == null) {
                            options.coordinate = arg;
                        } else {
                            throw new IllegalArgumentException("Unexpected argument: " + arg);
                        }
                    }
                }
            }
            if (options.repositories.isEmpty()) {
                options.repositories.add(DEFAULT_REPOSITORY);
            }
            return options;
        }

        private static String value(String[] args, int index, String option) {
            if (index >= args.length || args[index].isBlank()) {
                throw new IllegalArgumentException(option + " requires a value");
            }
            return args[index];
        }
    }

    public record ResolveResult(
        String coordinate,
        String scope,
        List<String> repositories,
        List<ResolvedArtifact> artifacts
    ) {
    }

    public record ResolvedArtifact(
        String groupId,
        String artifactId,
        String version,
        String classifier,
        String extension,
        String file,
        long size,
        String sha256
    ) {
        private static ResolvedArtifact from(Artifact artifact, File file) throws Exception {
            return new ResolvedArtifact(
                artifact.getGroupId(),
                artifact.getArtifactId(),
                artifact.getVersion(),
                artifact.getClassifier(),
                artifact.getExtension(),
                file.getAbsolutePath(),
                file.length(),
                DbxMavenResolver.sha256(file)
            );
        }
    }
}
