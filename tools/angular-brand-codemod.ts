import {
  ArrayLiteralExpression,
  ClassDeclaration,
  Decorator,
  ExportAssignment,
  ExportDeclaration,
  Identifier,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  QuoteKind,
  SourceFile,
  SyntaxKind,
  TypeNode,
  ts,
} from 'ts-morph';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

export type AngularKind = 'component' | 'directive' | 'pipe' | 'injectable';

export type TransformResult = {
  changed: boolean;
  skipped: boolean;
  warnings: string[];
  angularKind?: string;
  className?: string;
  dependencies: string[];
  dependencyGroups: DependencyGroups;
};

export type AngularBrandCodemodOptions = {
  helperImportPath?: string;
  transformOnlyStandaloneDeclarables?: boolean;
  includeProviders?: boolean;
  includeViewProviders?: boolean;
};

export type AngularClassSearchResult = {
  classDeclaration?: ClassDeclaration;
  angularKind?: AngularKind;
  className?: string;
  skipped: boolean;
  warnings: string[];
};

export type DependencyExtractionResult = {
  dependencies: string[];
  warnings: string[];
};

export type DependencyGroups = {
  injected: string[];
  importDeps: string[];
  providers: string[];
};

export type DependencyAnalysisResult = Omit<TransformResult, 'changed'> & {
  classDeclaration?: ClassDeclaration;
};

export type ExistingDependencyGroupsResult = {
  found: boolean;
  warnings: string[];
  dependencyGroups: DependencyGroups;
  exportAssignmentNode?: Node;
  depsObjectNode?: Node;
  propertyNodes: Partial<Record<keyof DependencyGroups, Node>>;
};

type MetadataDependencyGroups = {
  imports: string[];
  hostDirectives: string[];
  providers: string[];
  viewProviders: string[];
  warnings: string[];
};

type NormalizedOptions = Required<AngularBrandCodemodOptions>;

type InjectDecoratorTokenResult =
  | { found: false }
  | { found: true; dependency?: string };

type RunFileReport = TransformResult & {
  filePath: string;
};

export type RunSummary = {
  transformedFiles: number;
  skippedFiles: number;
  warnings: number;
  countByAngularKind: Record<AngularKind, number>;
  files: RunFileReport[];
};

const SUPPORTED_DECORATORS: Record<string, AngularKind> = {
  Component: 'component',
  Directive: 'directive',
  Pipe: 'pipe',
  Injectable: 'injectable',
};

const DEFAULT_OPTIONS: NormalizedOptions = {
  helperImportPath: '@craft-ng/core',
  transformOnlyStandaloneDeclarables: false,
  includeProviders: true,
  includeViewProviders: true,
};

const PRIMITIVE_TYPE_TEXTS = new Set([
  'any',
  'bigint',
  'boolean',
  'false',
  'never',
  'null',
  'number',
  'object',
  'string',
  'symbol',
  'true',
  'undefined',
  'unknown',
  'void',
  'Array',
  'Boolean',
  'Number',
  'Object',
  'ReadonlyArray',
  'String',
]);

const GENERATED_FILE_SUFFIXES = [
  '.d.ts',
  '.gen.ts',
  '.generated.ts',
  '.ngfactory.ts',
  '.ngsummary.ts',
  '.ngtypecheck.ts',
];

const IGNORED_DIRECTORIES = new Set([
  '.angular',
  '.git',
  '.nx',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out-tsc',
  'tmp',
]);

export function transformSourceFile(
  sourceFile: SourceFile,
  options: AngularBrandCodemodOptions = {},
): TransformResult {
  const normalizedOptions = normalizeOptions(options);
  const analysis = analyzeSourceFileDependencies(sourceFile, options);
  const result: TransformResult = {
    ...analysis,
    changed: false,
  };

  const { angularKind, classDeclaration, className } = analysis;

  if (analysis.skipped || !classDeclaration || !angularKind || !className) {
    return result;
  }

  const exportSafety = getExportRewriteSafety(sourceFile, classDeclaration, className);
  if (!exportSafety.safe) {
    return skip(result, exportSafety.warnings);
  }

  const importSafety = getHelperImportSafety(sourceFile, normalizedOptions.helperImportPath);
  if (!importSafety.safe) {
    return skip(result, importSafety.warnings);
  }

  removeConflictingExports(sourceFile, classDeclaration, className);
  ensureHelperImports(sourceFile, normalizedOptions.helperImportPath);
  writeDefaultBrandExport(sourceFile, className, result.dependencyGroups);

  result.changed = true;
  return result;
}

export function analyzeSourceFileDependencies(
  sourceFile: SourceFile,
  options: AngularBrandCodemodOptions = {},
): DependencyAnalysisResult {
  const normalizedOptions = normalizeOptions(options);
  const result: DependencyAnalysisResult = {
    skipped: false,
    warnings: [],
    dependencies: [],
    dependencyGroups: emptyDependencyGroups(),
  };

  const angularClass = findAngularDecoratedClass(sourceFile);
  result.warnings.push(...angularClass.warnings);
  result.angularKind = angularClass.angularKind;
  result.className = angularClass.className;
  result.classDeclaration = angularClass.classDeclaration;

  if (angularClass.skipped) {
    result.skipped = true;
    return result;
  }

  if (!angularClass.classDeclaration) {
    return result;
  }

  const { angularKind, classDeclaration, className } = angularClass;

  if (!angularKind || !className) {
    result.skipped = true;
    result.warnings.push('Angular class name or kind could not be resolved.');
    return result;
  }

  if (
    normalizedOptions.transformOnlyStandaloneDeclarables &&
    (angularKind === 'component' || angularKind === 'directive') &&
    !isStandaloneDeclarable(classDeclaration)
  ) {
    result.skipped = true;
    result.warnings.push(
      `${decoratorLabel(angularKind)} ${className} is not standalone and transformOnlyStandaloneDeclarables is enabled.`,
    );
    return result;
  }

  const metadataDeps =
    angularKind === 'component' || angularKind === 'directive'
      ? extractDecoratorMetadataDepGroups(classDeclaration, angularKind, normalizedOptions)
      : emptyMetadataDependencyGroups();
  const constructorDeps = extractConstructorDeps(classDeclaration);
  const injectCallDeps = extractInjectCallDeps(classDeclaration);

  result.warnings.push(
    ...metadataDeps.warnings,
    ...constructorDeps.warnings,
    ...injectCallDeps.warnings,
  );
  result.dependencies = mergeDeps(
    constructorDeps.dependencies,
    injectCallDeps.dependencies,
    metadataDeps.imports,
    metadataDeps.hostDirectives,
    metadataDeps.providers,
    metadataDeps.viewProviders,
  );
  result.dependencyGroups = {
    injected: mergeDeps(constructorDeps.dependencies, injectCallDeps.dependencies),
    importDeps: mergeDeps(metadataDeps.imports, metadataDeps.hostDirectives),
    providers: mergeDeps(metadataDeps.providers, metadataDeps.viewProviders),
  };

  return result;
}

export function findAngularDecoratedClass(sourceFile: SourceFile): AngularClassSearchResult {
  const decoratedClasses = sourceFile
    .getClasses()
    .map((classDeclaration) => {
      const angularKind = getAngularKind(classDeclaration);
      return angularKind ? { classDeclaration, angularKind } : undefined;
    })
    .filter((entry): entry is { classDeclaration: ClassDeclaration; angularKind: AngularKind } =>
      Boolean(entry),
    );

  if (decoratedClasses.length === 0) {
    return { skipped: false, warnings: [] };
  }

  if (decoratedClasses.length > 1) {
    return {
      skipped: true,
      warnings: [
        `Skipped file because it contains ${decoratedClasses.length} supported Angular classes.`,
      ],
    };
  }

  const [{ classDeclaration, angularKind }] = decoratedClasses;
  const className = classDeclaration.getName();
  if (!className) {
    return {
      classDeclaration,
      angularKind,
      skipped: true,
      warnings: ['Skipped anonymous default-exported Angular class.'],
    };
  }

  return {
    classDeclaration,
    angularKind,
    className,
    skipped: false,
    warnings: [],
  };
}

export function getAngularKind(classDeclaration: ClassDeclaration): AngularKind | undefined {
  for (const decorator of classDeclaration.getDecorators()) {
    const decoratorName = getDecoratorName(decorator);
    if (decoratorName && decoratorName in SUPPORTED_DECORATORS) {
      return SUPPORTED_DECORATORS[decoratorName];
    }
  }

  return undefined;
}

export function isStandaloneDeclarable(classDeclaration: ClassDeclaration): boolean {
  const angularKind = getAngularKind(classDeclaration);
  if (angularKind !== 'component' && angularKind !== 'directive') {
    return false;
  }

  const metadata = getDecoratorMetadataObject(classDeclaration);
  const standaloneProperty = metadata ? getObjectPropertyAssignment(metadata, 'standalone') : undefined;
  const initializer = standaloneProperty?.getInitializer();

  return Node.isTrueLiteral(initializer);
}

export function extractDecoratorMetadataDeps(
  classDeclaration: ClassDeclaration,
  angularKind = getAngularKind(classDeclaration),
  options: AngularBrandCodemodOptions = {},
): DependencyExtractionResult {
  if (angularKind !== 'component' && angularKind !== 'directive') {
    return { dependencies: [], warnings: [] };
  }

  const groups = extractDecoratorMetadataDepGroups(
    classDeclaration,
    angularKind,
    normalizeOptions(options),
  );

  return {
    dependencies: mergeDeps(
      groups.imports,
      groups.hostDirectives,
      groups.providers,
      groups.viewProviders,
    ),
    warnings: groups.warnings,
  };
}

export function extractConstructorDeps(
  classDeclaration: ClassDeclaration,
): DependencyExtractionResult {
  const warnings: string[] = [];
  const dependencies: string[] = [];

  for (const constructorDeclaration of classDeclaration.getConstructors()) {
    for (const parameter of constructorDeclaration.getParameters()) {
      const injectToken = getInjectDecoratorToken(parameter.getDecorators(), warnings);
      if (injectToken.found) {
        if (injectToken.dependency) {
          dependencies.push(injectToken.dependency);
        }
        continue;
      }

      const typeNode = parameter.getTypeNode();
      if (!typeNode) {
        warnings.push(`Skipped constructor parameter "${parameter.getName()}" because it has no type.`);
        continue;
      }

      const dependency = getDependencyTextFromTypeNode(typeNode);
      if (!dependency) {
        warnings.push(
          `Skipped constructor parameter "${parameter.getName()}" because type "${typeNode.getText()}" is not a static Angular dependency.`,
        );
        continue;
      }

      if (!isRuntimeSafeTypeDependency(typeNode, dependency)) {
        warnings.push(
          `Skipped constructor dependency "${dependency}" because it is unresolved, type-only, or not a runtime value.`,
        );
        continue;
      }

      dependencies.push(dependency);
    }
  }

  return { dependencies: mergeDeps(dependencies), warnings };
}

export function extractInjectCallDeps(classDeclaration: ClassDeclaration): DependencyExtractionResult {
  const warnings: string[] = [];
  const dependencies: string[] = [];

  for (const callExpression of classDeclaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = callExpression.getExpression();
    const injectMethodName = getInjectMethodName(expression);
    if (!injectMethodName?.startsWith('inject')) {
      continue;
    }

    const dependency =
      injectMethodName === 'inject'
        ? getAngularInjectCallDependency(callExpression)
        : getInjectionHelperDependency(expression);

    if (!dependency) {
      warnings.push(
        `Skipped ${injectMethodName}() call in ${classDeclaration.getName() ?? 'anonymous class'} because the injection dependency is not static.`,
      );
      continue;
    }

    dependencies.push(dependency);
  }

  return { dependencies: mergeDeps(dependencies), warnings };
}

export function mergeDeps(...dependencyGroups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const dependencies: string[] = [];

  for (const group of dependencyGroups) {
    for (const dependency of group) {
      if (seen.has(dependency)) {
        continue;
      }

      seen.add(dependency);
      dependencies.push(dependency);
    }
  }

  return dependencies;
}

function emptyDependencyGroups(): DependencyGroups {
  return {
    injected: [],
    importDeps: [],
    providers: [],
  };
}

function createDepsExpression(dependencyGroups: DependencyGroups): string {
  return `deps({ injected: [${dependencyGroups.injected.join(', ')}], importDeps: [${dependencyGroups.importDeps.join(', ')}], providers: [${dependencyGroups.providers.join(', ')}] })`;
}

function invalidExistingDependencyGroups(
  node: Node,
  warnings: string[],
): ExistingDependencyGroupsResult {
  return {
    found: true,
    warnings,
    dependencyGroups: emptyDependencyGroups(),
    exportAssignmentNode: node,
    depsObjectNode: node,
    propertyNodes: {},
  };
}

function readExistingDependencyGroupProperty(
  objectLiteral: ObjectLiteralExpression,
  propertyName: keyof DependencyGroups,
  warnings: string[],
  propertyNodes: ExistingDependencyGroupsResult['propertyNodes'],
): string[] {
  const property = getObjectPropertyAssignment(objectLiteral, propertyName);
  if (!property) {
    warnings.push(`deps(...) is missing the "${propertyName}" array.`);
    return [];
  }

  propertyNodes[propertyName] = property;
  const initializer = property.getInitializer();
  if (!Node.isArrayLiteralExpression(initializer)) {
    warnings.push(`deps.${propertyName} must be a static array.`);
    return [];
  }

  const dependencies: string[] = [];

  for (const element of initializer.getElements()) {
    const dependency = getStaticExpressionText(element);
    if (!dependency) {
      warnings.push(`deps.${propertyName} contains a non-static expression: ${element.getText()}`);
      continue;
    }

    dependencies.push(dependency);
  }

  return dependencies;
}

function getInjectMethodName(expression: Node): string | undefined {
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }

  return undefined;
}

function getAngularInjectCallDependency(callExpression: import('ts-morph').CallExpression): string | undefined {
  const [token] = callExpression.getArguments();
  return getStaticExpressionText(token);
}

function getInjectionHelperDependency(expression: Node): string | undefined {
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const left = expression.getExpression();
    if (Node.isIdentifier(left)) {
      return expression.getText();
    }
  }

  return undefined;
}

export function ensureHelperImports(sourceFile: SourceFile, helperImportPath: string): void {
  const missingImports = ['brandAngularSymbol', 'deps'].filter(
    (importName) => !hasLocalNamedImport(sourceFile, helperImportPath, importName),
  );

  if (missingImports.length === 0) {
    return;
  }

  const existingImport = sourceFile
    .getImportDeclarations()
    .find((importDeclaration) => importDeclaration.getModuleSpecifierValue() === helperImportPath);

  if (existingImport) {
    existingImport.addNamedImports(missingImports);
    return;
  }

  sourceFile.addImportDeclaration({
    moduleSpecifier: helperImportPath,
    namedImports: missingImports,
  });
}

export function removeConflictingExports(
  sourceFile: SourceFile,
  classDeclaration: ClassDeclaration,
  className: string,
): void {
  if (classDeclaration.isDefaultExport()) {
    classDeclaration.setIsDefaultExport(false);
  }

  if (classDeclaration.isExported()) {
    classDeclaration.setIsExported(false);
  }

  for (const exportAssignment of sourceFile.getExportAssignments()) {
    if (
      isDefaultIdentifierExport(exportAssignment, className) ||
      isDefaultBrandedExport(exportAssignment, className)
    ) {
      exportAssignment.remove();
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    removeClassFromExportDeclaration(exportDeclaration, className);
  }
}

export function writeDefaultBrandExport(
  sourceFile: SourceFile,
  className: string,
  dependencyGroups: DependencyGroups,
): void {
  sourceFile.addExportAssignment({
    expression: `brandAngularSymbol(${className}, ${createDepsExpression(dependencyGroups)})`,
    isExportEquals: false,
  });
}

export function readExistingDependencyGroups(
  sourceFile: SourceFile,
  className?: string,
): ExistingDependencyGroupsResult {
  const defaultExport = sourceFile.getExportAssignments().find((exportAssignment) => {
    if (exportAssignment.isExportEquals()) {
      return false;
    }

    const expression = exportAssignment.getExpression();
    if (!Node.isCallExpression(expression)) {
      return false;
    }

    const callTarget = expression.getExpression();
    if (!Node.isIdentifier(callTarget) || callTarget.getText() !== 'brandAngularSymbol') {
      return false;
    }

    if (!className) {
      return true;
    }

    const [targetClass] = expression.getArguments();
    return Node.isIdentifier(targetClass) && targetClass.getText() === className;
  });

  if (!defaultExport) {
    return {
      found: false,
      warnings: [],
      dependencyGroups: emptyDependencyGroups(),
      propertyNodes: {},
    };
  }

  const expression = defaultExport.getExpression();
  if (!Node.isCallExpression(expression)) {
    return invalidExistingDependencyGroups(
      defaultExport,
      ['Default export must call brandAngularSymbol(ClassName, deps({ ... })).'],
    );
  }

  const [, depsArgument] = expression.getArguments();
  if (!Node.isCallExpression(depsArgument)) {
    return invalidExistingDependencyGroups(
      defaultExport,
      ['brandAngularSymbol must receive deps({ injected, importDeps, providers }).'],
    );
  }

  const depsCallTarget = depsArgument.getExpression();
  if (!Node.isIdentifier(depsCallTarget) || depsCallTarget.getText() !== 'deps') {
    return invalidExistingDependencyGroups(
      depsArgument,
      ['brandAngularSymbol second argument must be a deps(...) call.'],
    );
  }

  const [depsObject] = depsArgument.getArguments();
  if (!Node.isObjectLiteralExpression(depsObject)) {
    return invalidExistingDependencyGroups(
      depsArgument,
      ['deps(...) must be called with an object literal.'],
    );
  }

  const warnings: string[] = [];
  const propertyNodes: ExistingDependencyGroupsResult['propertyNodes'] = {};
  const dependencyGroups: DependencyGroups = {
    injected: readExistingDependencyGroupProperty(
      depsObject,
      'injected',
      warnings,
      propertyNodes,
    ),
    importDeps: readExistingDependencyGroupProperty(
      depsObject,
      'importDeps',
      warnings,
      propertyNodes,
    ),
    providers: readExistingDependencyGroupProperty(
      depsObject,
      'providers',
      warnings,
      propertyNodes,
    ),
  };

  return {
    found: true,
    warnings,
    dependencyGroups,
    exportAssignmentNode: defaultExport,
    depsObjectNode: depsObject,
    propertyNodes,
  };
}

export function formatDependencyGroups(dependencyGroups: DependencyGroups): string {
  return [
    `injected=[${dependencyGroups.injected.join(', ')}]`,
    `importDeps=[${dependencyGroups.importDeps.join(', ')}]`,
    `providers=[${dependencyGroups.providers.join(', ')}]`,
  ].join(' ');
}

export async function runAngularBrandCodemod(
  options: AngularBrandCodemodOptions & {
    rootDir?: string;
    tsConfigFilePath?: string;
    dryRun?: boolean;
    log?: (message: string) => void;
  } = {},
): Promise<RunSummary> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const tsConfigFilePath = options.tsConfigFilePath
    ? resolve(options.tsConfigFilePath)
    : getDefaultTsConfigPath(rootDir);
  const project = createProject(tsConfigFilePath);
  const files = collectTypeScriptFiles(rootDir);

  project.addSourceFilesAtPaths(files);
  setProjectQuoteKind(project);

  const summary: RunSummary = {
    transformedFiles: 0,
    skippedFiles: 0,
    warnings: 0,
    countByAngularKind: {
      component: 0,
      directive: 0,
      injectable: 0,
      pipe: 0,
    },
    files: [],
  };

  for (const sourceFile of project.getSourceFiles()) {
    if (!isWithinRoot(sourceFile.getFilePath(), rootDir)) {
      continue;
    }

    const result = transformSourceFile(sourceFile, options);
    const report: RunFileReport = {
      ...result,
      filePath: sourceFile.getFilePath(),
    };

    summary.files.push(report);
    summary.warnings += result.warnings.length;

    if (result.changed) {
      summary.transformedFiles += 1;
      if (result.angularKind && result.angularKind in summary.countByAngularKind) {
        summary.countByAngularKind[result.angularKind as AngularKind] += 1;
      }

      if (!options.dryRun) {
        await sourceFile.save();
      }
    }

    if (result.skipped) {
      summary.skippedFiles += 1;
    }

    logFileResult(report, options.log ?? console.log);
  }

  logSummary(summary, options.log ?? console.log);
  return summary;
}

function normalizeOptions(options: AngularBrandCodemodOptions): NormalizedOptions {
  return {
    helperImportPath: options.helperImportPath ?? DEFAULT_OPTIONS.helperImportPath,
    transformOnlyStandaloneDeclarables:
      options.transformOnlyStandaloneDeclarables ??
      DEFAULT_OPTIONS.transformOnlyStandaloneDeclarables,
    includeProviders: options.includeProviders ?? DEFAULT_OPTIONS.includeProviders,
    includeViewProviders: options.includeViewProviders ?? DEFAULT_OPTIONS.includeViewProviders,
  };
}

function skip(result: TransformResult, warnings: string[]): TransformResult {
  result.skipped = true;
  result.warnings.push(...warnings);
  return result;
}

function getDecoratorName(decorator: Decorator): string | undefined {
  const expression = decorator.getExpression();
  if (Node.isCallExpression(expression)) {
    const callTarget = expression.getExpression();
    if (Node.isIdentifier(callTarget)) {
      return callTarget.getText();
    }

    if (Node.isPropertyAccessExpression(callTarget)) {
      return callTarget.getName();
    }

    return undefined;
  }

  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }

  return undefined;
}

function decoratorLabel(angularKind: AngularKind): string {
  switch (angularKind) {
    case 'component':
      return '@Component';
    case 'directive':
      return '@Directive';
    case 'pipe':
      return '@Pipe';
    case 'injectable':
      return '@Injectable';
  }
}

function getDecoratorMetadataObject(
  classDeclaration: ClassDeclaration,
): ObjectLiteralExpression | undefined {
  for (const decorator of classDeclaration.getDecorators()) {
    if (!getAngularKindFromDecorator(decorator)) {
      continue;
    }

    const callExpression = decorator.getCallExpression();
    const [metadata] = callExpression?.getArguments() ?? [];
    if (Node.isObjectLiteralExpression(metadata)) {
      return metadata;
    }
  }

  return undefined;
}

function getAngularKindFromDecorator(decorator: Decorator): AngularKind | undefined {
  const decoratorName = getDecoratorName(decorator);
  return decoratorName && decoratorName in SUPPORTED_DECORATORS
    ? SUPPORTED_DECORATORS[decoratorName]
    : undefined;
}

function getObjectPropertyAssignment(
  objectLiteral: ObjectLiteralExpression,
  propertyName: string,
): PropertyAssignment | undefined {
  const property = objectLiteral.getProperties().find((objectProperty) => {
    if (!Node.isPropertyAssignment(objectProperty)) {
      return false;
    }

    return getStaticPropertyName(objectProperty.getNameNode()) === propertyName;
  });

  return Node.isPropertyAssignment(property) ? property : undefined;
}

function extractDecoratorMetadataDepGroups(
  classDeclaration: ClassDeclaration,
  angularKind: AngularKind,
  options: NormalizedOptions,
): MetadataDependencyGroups {
  const metadata = getDecoratorMetadataObject(classDeclaration);
  const groups = emptyMetadataDependencyGroups();

  if (!metadata) {
    return groups;
  }

  groups.imports = extractMetadataArrayProperty(metadata, 'imports', 'imports', groups.warnings);
  groups.hostDirectives = extractMetadataArrayProperty(
    metadata,
    'hostDirectives',
    'hostDirectives',
    groups.warnings,
  );

  if (options.includeProviders) {
    groups.providers = extractMetadataArrayProperty(
      metadata,
      'providers',
      'providers',
      groups.warnings,
    );
  }

  if (options.includeViewProviders && angularKind === 'component') {
    groups.viewProviders = extractMetadataArrayProperty(
      metadata,
      'viewProviders',
      'viewProviders',
      groups.warnings,
    );
  }

  return groups;
}

function emptyMetadataDependencyGroups(): MetadataDependencyGroups {
  return {
    imports: [],
    hostDirectives: [],
    providers: [],
    viewProviders: [],
    warnings: [],
  };
}

function extractMetadataArrayProperty(
  metadata: ObjectLiteralExpression,
  propertyName: string,
  context: string,
  warnings: string[],
): string[] {
  const property = getObjectPropertyAssignment(metadata, propertyName);
  if (!property) {
    return [];
  }

  const initializer = property.getInitializer();
  if (!Node.isArrayLiteralExpression(initializer)) {
    warnings.push(`Skipped metadata property "${propertyName}" because it is not a static array.`);
    return [];
  }

  return extractStaticArrayElements(initializer, context, warnings);
}

function extractStaticArrayElements(
  arrayLiteral: ArrayLiteralExpression,
  context: string,
  warnings: string[],
): string[] {
  const dependencies: string[] = [];

  for (const element of arrayLiteral.getElements()) {
    if (Node.isArrayLiteralExpression(element)) {
      dependencies.push(...extractStaticArrayElements(element, context, warnings));
      continue;
    }

    if (Node.isSpreadElement(element)) {
      warnings.push(`Skipped spread element in "${context}" metadata dependencies.`);
      continue;
    }

    if (isProviderContext(context) && Node.isCallExpression(element)) {
      const providerFactory = getStaticExpressionText(element.getExpression());
      if (providerFactory) {
        dependencies.push(providerFactory);
        continue;
      }
    }

    const dependency = getStaticExpressionText(element);
    if (dependency) {
      dependencies.push(dependency);
      continue;
    }

    if (Node.isObjectLiteralExpression(element)) {
      dependencies.push(...extractStaticObjectElementDependencies(element, context, warnings));
      continue;
    }

    warnings.push(
      `Skipped complex expression "${element.getText()}" in "${context}" metadata dependencies.`,
    );
  }

  return dependencies;
}

function isProviderContext(context: string): boolean {
  return context === 'providers' || context === 'viewProviders';
}

function extractStaticObjectElementDependencies(
  objectLiteral: ObjectLiteralExpression,
  context: string,
  warnings: string[],
): string[] {
  const dependencies: string[] = [];
  const knownValueProperties =
    context === 'hostDirectives'
      ? new Set(['directive'])
      : new Set(['provide', 'useClass', 'useExisting']);

  for (const property of objectLiteral.getProperties()) {
    if (!Node.isPropertyAssignment(property)) {
      warnings.push(`Skipped complex object member in "${context}" metadata dependencies.`);
      continue;
    }

    const propertyName = getStaticPropertyName(property.getNameNode());

    if (!propertyName || !knownValueProperties.has(propertyName)) {
      continue;
    }

    const dependency = getStaticExpressionText(property.getInitializer());
    if (dependency) {
      dependencies.push(dependency);
      continue;
    }

    warnings.push(
      `Skipped complex "${propertyName}" value in "${context}" metadata dependencies.`,
    );
  }

  return dependencies;
}

function getInjectDecoratorToken(
  decorators: Decorator[],
  warnings: string[],
): InjectDecoratorTokenResult {
  for (const decorator of decorators) {
    if (getDecoratorName(decorator) !== 'Inject') {
      continue;
    }

    const [token] = decorator.getCallExpression()?.getArguments() ?? [];
    const dependency = getStaticExpressionText(token);
    if (!dependency) {
      warnings.push('Skipped @Inject() dependency because the token is not a static identifier.');
      return { found: true };
    }

    return { found: true, dependency };
  }

  return { found: false };
}

function getStaticExpressionText(expression: Node | undefined): string | undefined {
  if (!expression) {
    return undefined;
  }

  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getText();
  }

  return undefined;
}

function getStaticPropertyName(nameNode: Node): string | undefined {
  if (Node.isIdentifier(nameNode)) {
    return nameNode.getText();
  }

  if (Node.isStringLiteral(nameNode) || Node.isNumericLiteral(nameNode)) {
    return nameNode.getLiteralText();
  }

  return undefined;
}

function getDependencyTextFromTypeNode(typeNode: TypeNode): string | undefined {
  if (isPrimitiveTypeNode(typeNode)) {
    return undefined;
  }

  if (Node.isTypeReference(typeNode)) {
    const typeName = typeNode.getTypeName();
    const dependency = typeName.getText();
    return isPrimitiveDependencyText(dependency) ? undefined : dependency;
  }

  if (Node.isExpressionWithTypeArguments(typeNode)) {
    const expression = typeNode.getExpression();
    return getStaticExpressionText(expression);
  }

  return undefined;
}

function isPrimitiveTypeNode(typeNode: TypeNode): boolean {
  return [
    SyntaxKind.AnyKeyword,
    SyntaxKind.BigIntKeyword,
    SyntaxKind.BooleanKeyword,
    SyntaxKind.FalseKeyword,
    SyntaxKind.NeverKeyword,
    SyntaxKind.NullKeyword,
    SyntaxKind.NumberKeyword,
    SyntaxKind.ObjectKeyword,
    SyntaxKind.StringKeyword,
    SyntaxKind.SymbolKeyword,
    SyntaxKind.TrueKeyword,
    SyntaxKind.UndefinedKeyword,
    SyntaxKind.UnknownKeyword,
    SyntaxKind.VoidKeyword,
  ].includes(typeNode.getKind());
}

function isPrimitiveDependencyText(dependency: string): boolean {
  return PRIMITIVE_TYPE_TEXTS.has(dependency);
}

function isRuntimeSafeTypeDependency(typeNode: TypeNode, dependency: string): boolean {
  const identifiers = getDependencyIdentifiersFromTypeNode(typeNode);
  if (identifiers.length === 0 || identifiers.map((identifier) => identifier.getText()).join('.') !== dependency) {
    return false;
  }

  const [rootIdentifier] = identifiers;
  const leafIdentifier = identifiers[identifiers.length - 1];
  const isQualifiedDependency = identifiers.length > 1;

  return (
    isRuntimeSafeIdentifier(rootIdentifier, { allowNamespaceContainer: isQualifiedDependency }) &&
    isRuntimeSafeIdentifier(leafIdentifier, { allowNamespaceContainer: false })
  );
}

function getDependencyIdentifiersFromTypeNode(typeNode: TypeNode): Identifier[] {
  if (!Node.isTypeReference(typeNode)) {
    return [];
  }

  const typeName = typeNode.getTypeName();
  if (Node.isIdentifier(typeName)) {
    return [typeName];
  }

  return typeName.getDescendantsOfKind(SyntaxKind.Identifier);
}

function isRuntimeSafeIdentifier(
  identifier: Identifier,
  options: { allowNamespaceContainer: boolean },
): boolean {
  const symbol = identifier.getSymbol() ?? identifier.getType().getSymbol();
  if (!symbol) {
    return false;
  }

  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) {
    return false;
  }

  if (declarations.some((declaration) => isTypeOnlyImportDeclaration(declaration))) {
    return false;
  }

  if (
    options.allowNamespaceContainer &&
    declarations.some((declaration) => Node.isNamespaceImport(declaration))
  ) {
    return true;
  }

  const aliasedSymbol = symbol.getAliasedSymbol();
  const runtimeDeclarations = aliasedSymbol?.getDeclarations() ?? declarations;
  if (runtimeDeclarations.length === 0) {
    return false;
  }

  return runtimeDeclarations.some((declaration) =>
    isRuntimeValueDeclaration(declaration, options),
  );
}

function isTypeOnlyImportDeclaration(declaration: Node): boolean {
  if (Node.isImportSpecifier(declaration)) {
    return declaration.isTypeOnly() || declaration.getImportDeclaration().isTypeOnly();
  }

  if (Node.isImportClause(declaration)) {
    return declaration.isTypeOnly();
  }

  if (Node.isNamespaceImport(declaration)) {
    return declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.isTypeOnly() ?? false;
  }

  return false;
}

function isRuntimeValueDeclaration(
  declaration: Node,
  options: { allowNamespaceContainer: boolean },
): boolean {
  if (
    Node.isClassDeclaration(declaration) ||
    Node.isEnumDeclaration(declaration) ||
    Node.isFunctionDeclaration(declaration) ||
    Node.isVariableDeclaration(declaration)
  ) {
    return true;
  }

  if (options.allowNamespaceContainer && Node.isModuleDeclaration(declaration)) {
    return true;
  }

  return false;
}

function getExportRewriteSafety(
  sourceFile: SourceFile,
  classDeclaration: ClassDeclaration,
  className: string,
): { safe: true; warnings: [] } | { safe: false; warnings: string[] } {
  const warnings: string[] = [];

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isDefaultExport()) {
      warnings.push('Skipped file because it has an unrelated default-exported function.');
    }

    if (
      Node.isClassDeclaration(statement) &&
      statement !== classDeclaration &&
      statement.isDefaultExport()
    ) {
      warnings.push('Skipped file because it has an unrelated default-exported class.');
    }
  }

  for (const exportAssignment of sourceFile.getExportAssignments()) {
    if (exportAssignment.isExportEquals()) {
      warnings.push('Skipped file because export = is not safe to combine with export default.');
      continue;
    }

    if (
      !isDefaultIdentifierExport(exportAssignment, className) &&
      !isDefaultBrandedExport(exportAssignment, className)
    ) {
      warnings.push(
        `Skipped file because it has a complex default export: ${exportAssignment.getText()}`,
      );
    }
  }

  for (const exportDeclaration of sourceFile.getExportDeclarations()) {
    const defaultExportSpecifier = exportDeclaration.getNamedExports().find((specifier) => {
      const alias = specifier.getAliasNode()?.getText();
      return alias === 'default' || (!alias && specifier.getName() === 'default');
    });

    if (defaultExportSpecifier && defaultExportSpecifier.getName() !== className) {
      warnings.push('Skipped file because it has an unrelated named default export.');
    }

    if (exportDeclaration.getModuleSpecifier()) {
      const reExportsClass = exportDeclaration
        .getNamedExports()
        .some((specifier) => specifier.getName() === className);
      if (reExportsClass) {
        warnings.push(
          `Skipped file because it re-exports "${className}" from another module.`,
        );
      }
    }
  }

  return warnings.length === 0 ? { safe: true, warnings: [] } : { safe: false, warnings };
}

function getHelperImportSafety(
  sourceFile: SourceFile,
  helperImportPath: string,
): { safe: true; warnings: [] } | { safe: false; warnings: string[] } {
  const warnings = ['brandAngularSymbol', 'deps']
    .filter((helperName) => hasConflictingTopLevelBinding(sourceFile, helperImportPath, helperName))
    .map(
      (helperName) =>
        `Skipped file because "${helperName}" is already bound to a different top-level symbol.`,
    );

  return warnings.length === 0 ? { safe: true, warnings: [] } : { safe: false, warnings };
}

function hasConflictingTopLevelBinding(
  sourceFile: SourceFile,
  helperImportPath: string,
  helperName: string,
): boolean {
  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    if (importDeclaration.getDefaultImport()?.getText() === helperName) {
      return true;
    }

    if (importDeclaration.getNamespaceImport()?.getText() === helperName) {
      return true;
    }

    for (const namedImport of importDeclaration.getNamedImports()) {
      const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      if (localName !== helperName) {
        continue;
      }

      return importDeclaration.getModuleSpecifierValue() !== helperImportPath;
    }
  }

  for (const statement of sourceFile.getStatements()) {
    if (Node.isClassDeclaration(statement) && statement.getName() === helperName) {
      return true;
    }

    if (Node.isFunctionDeclaration(statement) && statement.getName() === helperName) {
      return true;
    }

    if (Node.isEnumDeclaration(statement) && statement.getName() === helperName) {
      return true;
    }

    if (Node.isInterfaceDeclaration(statement) && statement.getName() === helperName) {
      return true;
    }

    if (Node.isTypeAliasDeclaration(statement) && statement.getName() === helperName) {
      return true;
    }

    if (Node.isVariableStatement(statement)) {
      const hasVariableName = statement
        .getDeclarationList()
        .getDeclarations()
        .some((declaration) => declaration.getName() === helperName);
      if (hasVariableName) {
        return true;
      }
    }
  }

  return false;
}

function isDefaultIdentifierExport(exportAssignment: ExportAssignment, className: string): boolean {
  if (exportAssignment.isExportEquals()) {
    return false;
  }

  const expression = exportAssignment.getExpression();
  return Node.isIdentifier(expression) && expression.getText() === className;
}

function isDefaultBrandedExport(exportAssignment: ExportAssignment, className: string): boolean {
  if (exportAssignment.isExportEquals()) {
    return false;
  }

  const expression = exportAssignment.getExpression();
  if (!Node.isCallExpression(expression)) {
    return false;
  }

  const callTarget = expression.getExpression();
  if (!Node.isIdentifier(callTarget) || callTarget.getText() !== 'brandAngularSymbol') {
    return false;
  }

  const [targetClass] = expression.getArguments();
  return Node.isIdentifier(targetClass) && targetClass.getText() === className;
}

function removeClassFromExportDeclaration(
  exportDeclaration: ExportDeclaration,
  className: string,
): void {
  if (exportDeclaration.getModuleSpecifier()) {
    return;
  }

  for (const namedExport of exportDeclaration.getNamedExports()) {
    if (namedExport.getName() === className) {
      namedExport.remove();
    }
  }

  if (exportDeclaration.getNamedExports().length === 0) {
    exportDeclaration.remove();
  }
}

function hasLocalNamedImport(
  sourceFile: SourceFile,
  helperImportPath: string,
  importName: string,
): boolean {
  return sourceFile.getImportDeclarations().some((importDeclaration) => {
    if (importDeclaration.getModuleSpecifierValue() !== helperImportPath) {
      return false;
    }

    return importDeclaration.getNamedImports().some((namedImport) => {
      const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      return localName === importName;
    });
  });
}

function createProject(tsConfigFilePath: string | undefined): Project {
  if (tsConfigFilePath) {
    return new Project({
      skipAddingFilesFromTsConfig: true,
      tsConfigFilePath,
    });
  }

  return new Project({
    compilerOptions: {
      experimentalDecorators: true,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
  });
}

function getDefaultTsConfigPath(rootDir: string): string | undefined {
  const tsConfigPath = join(rootDir, 'tsconfig.json');
  return existsSync(tsConfigPath) ? tsConfigPath : undefined;
}

function collectTypeScriptFiles(rootDir: string): string[] {
  const files: string[] = [];
  collectTypeScriptFilesInto(rootDir, files);
  return files;
}

function collectTypeScriptFilesInto(directory: string, files: string[]): void {
  for (const entryName of readdirSync(directory)) {
    const entryPath = join(directory, entryName);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entryName)) {
        collectTypeScriptFilesInto(entryPath, files);
      }
      continue;
    }

    if (!stats.isFile() || extname(entryName) !== '.ts' || isGeneratedFile(entryPath)) {
      continue;
    }

    files.push(entryPath);
  }
}

function isGeneratedFile(filePath: string): boolean {
  const fileName = basename(filePath);
  return (
    GENERATED_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix)) ||
    filePath.includes('/generated/') ||
    filePath.includes('\\generated\\')
  );
}

function setProjectQuoteKind(project: Project): void {
  const firstModuleSpecifier = project
    .getSourceFiles()
    .flatMap((sourceFile) => sourceFile.getImportDeclarations())
    .map((importDeclaration) => importDeclaration.getModuleSpecifier().getText())
    .find(Boolean);

  project.manipulationSettings.set({
    quoteKind: firstModuleSpecifier?.startsWith('"') ? QuoteKind.Double : QuoteKind.Single,
  });
}

function isWithinRoot(filePath: string, rootDir: string): boolean {
  const absoluteFilePath = isAbsolute(filePath) ? filePath : resolve(filePath);
  return absoluteFilePath === rootDir || absoluteFilePath.startsWith(`${rootDir}/`);
}

function logFileResult(report: RunFileReport, log: (message: string) => void): void {
  if (!report.changed && !report.skipped && !report.angularKind) {
    return;
  }

  const status = report.changed ? 'transformed' : report.skipped ? 'skipped' : 'unchanged';
  const details = [
    `file=${report.filePath}`,
    report.angularKind ? `kind=${report.angularKind}` : undefined,
    report.className ? `class=${report.className}` : undefined,
    `injected=[${report.dependencyGroups.injected.join(', ')}]`,
    `importDeps=[${report.dependencyGroups.importDeps.join(', ')}]`,
    `providers=[${report.dependencyGroups.providers.join(', ')}]`,
    `status=${status}`,
  ].filter(Boolean);

  log(details.join(' '));

  for (const warning of report.warnings) {
    log(`  warning: ${warning}`);
  }
}

function logSummary(summary: RunSummary, log: (message: string) => void): void {
  log(
    [
      `summary transformed=${summary.transformedFiles}`,
      `skipped=${summary.skippedFiles}`,
      `warnings=${summary.warnings}`,
      `components=${summary.countByAngularKind.component}`,
      `directives=${summary.countByAngularKind.directive}`,
      `pipes=${summary.countByAngularKind.pipe}`,
      `injectables=${summary.countByAngularKind.injectable}`,
    ].join(' '),
  );
}

function parseCliArgs(argv: string[]): AngularBrandCodemodOptions & {
  rootDir?: string;
  tsConfigFilePath?: string;
  dryRun?: boolean;
} {
  const options: AngularBrandCodemodOptions & {
    rootDir?: string;
    tsConfigFilePath?: string;
    dryRun?: boolean;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--root':
        options.rootDir = argv[++index];
        break;
      case '--tsconfig':
        options.tsConfigFilePath = argv[++index];
        break;
      case '--helper-import':
        options.helperImportPath = argv[++index];
        break;
      case '--transform-only-standalone-declarables':
        options.transformOnlyStandaloneDeclarables = true;
        break;
      case '--no-providers':
        options.includeProviders = false;
        break;
      case '--no-view-providers':
        options.includeViewProviders = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        printHelpAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelpAndExit(): never {
  console.log(`Usage: ts-node tools/angular-brand-codemod.ts [options]

Options:
  --root <dir>                                  Project root. Defaults to cwd.
  --tsconfig <path>                            tsconfig path. Defaults to <root>/tsconfig.json.
  --helper-import <path>                       Import path for brandAngularSymbol and deps.
  --transform-only-standalone-declarables      Only transform standalone components/directives.
  --no-providers                               Do not include metadata providers in deps().
  --no-view-providers                          Do not include component viewProviders in deps().
  --dry-run                                    Print results without writing files.
  --help                                       Show this help.
`);
  process.exit(0);
}

if (require.main === module) {
  runAngularBrandCodemod(parseCliArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
