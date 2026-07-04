const ts = require('typescript');
const path = require('path');
const fs = require('fs');
const projectPath = path.resolve('src/tsconfig.json');
const rootDir = path.resolve('src');
const overrideOptions = {
    verbose: false,
    sourceMap: true,
    rootDir: rootDir,
    baseUrl: rootDir,
    inlineSourceMap: true,
};
const parsed = ts.readConfigFile(projectPath, ts.sys.readFile);
const cmdLine = ts.parseJsonConfigFileContent(parsed.config, ts.sys, path.dirname(projectPath), overrideOptions);
console.log('Total files:', cmdLine.fileNames.length);
const agentHostFiles = cmdLine.fileNames.filter(f => /agentHost/i.test(f));
console.log('AgentHost files:', agentHostFiles.length);
if (agentHostFiles.length > 0) {
    console.log('First 10:');
    agentHostFiles.slice(0, 10).forEach(f => console.log('  ', f));
}
// Check the tsconfig exclude patterns
console.log('Exclude patterns:', JSON.stringify(parsed.config.exclude, null, 2));
