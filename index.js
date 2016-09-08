#!/usr/bin/env node
'use strict';

require('console.table');
var crypto = require('crypto');
var fs = require('fs');
var chalk = require('chalk');
var glob = require('glob');
var path = require('path');

var Message = require('./message');
var state = require('./state');
var config = require('./config');
var towelie = require('./assets/towelie');

init();

function init () {
  // We show towelie picture for fun
  console.log(chalk.green(towelie));
  // We expect the glob argument to ALWAYS be the first argument 
  let glob = process.argv[2];
  if(!glob) { glob = '**/*.*'; }

  /*
    This application has 4 different stages: (1) configure (2) read (3) compare the contents
    and (4) report towlie's findings. In stage 2, read, we pass in the global variable "config", required above, 
    otherwise we are just piping functions
  */
  configure()
    .then(function (config) { return read(glob.toString(), config); })
    .then(function (docs){ return compare(docs); })
    .then(function (messages){ return report(messages); })
    .catch(function (err) { throw err; });
}

function configure () {
  return new Promise(function (resolve, reject) {
    // Attempt to read the .trc file, which is the designated name for a twly config file
    fs.readFile(process.cwd() + '/.trc', 'utf-8', function (err, data) {
      let o = { ignore: [] };
      if (err) {
        o.ignore = config.ignore;
      } else {
        // The required format of the config file is JSON
        let userConf = JSON.parse(data);
        let ignore = userConf.ignore;
        // If user supplied ignore values, we get their fully qualified paths and add them to ignore array
        ignore && ignore.forEach(function (p) { o.ignore.push(path.join(process.cwd(), p)); });
        // Checking for the existence of individual properties and copying over their values if they exist
        if (userConf.failureThreshold) { config.failureThreshold = userConf.failureThreshold; }
        if (userConf.minLines) { config.minLines = userConf.minLines; }
        if (userConf.minChars) { config.minChars = userConf.minChars; }
      }
      resolve(o);
    });
  });
}

function read (pathsToRead, config) {
  return new Promise(function (resolve, reject) {
    var docs = [];
    glob(path.join(process.cwd(), pathsToRead), config, function (err, paths) {
      paths.forEach(function (p, i) {

        /*
          Reading in all documents and only firing off the comparison once all have been read.
          This is signaled by invoking the promise's resolve function and passing it an array of documents. 
        */
        fs.readFile(p, function (err, data) {
          if (err) { throw err; }
          state.totalFiles++;
          state.totalLines += numLines(data.toString());
          docs.push({ content: data.toString(), filePath: p, pi: i });
          if (docs.length === paths.length) { resolve(docs); }
        });
      });
    });
  });
}

function compare (docs) {
  let messages = [];
  let fullDocHashes = {};
  let allBlockHashes = {};

  for (let i = 0; i < docs.length; i++) {
    let iPOriginal = removeEmpty(makeParagraphArray(docs[i].content));
    let iP = normalize(iPOriginal);
    let hash = hashString(minify(docs[i].content));

    /*
      We check if the hash of ALL of the minified content in current document already exists in our array of hashes
      If it does, that means we have a duplicate of an entire document, so we check to see if there is a message with 
      that hash as a reference, and if there is then we add the docpath to the message... otherwise just add message
    */
    if (hash in fullDocHashes) {
      let existingMsgInd = fullDocHashes[hash].msgInd;
      if (existingMsgInd) {
        messages[existingMsgInd].docs.push(docs[i].filePath);
      } else {
        // Sort of clever: before augmenting the length of the array by pushing to it, I am grabbing the current length for that index
        fullDocHashes[hash].msgInd = messages.length;
        messages.push(new Message([docs[i].filePath, docs[fullDocHashes[hash].ind].filePath], 0, ''));
      }
      // Increment the relevant counters for reporting
      state.dupedLines += (numLines(docs[i].content) * 2);
      state.numFileDupes++;
      continue;
    }

    fullDocHashes[hash] = { ind: i };

    for (let p = 0; p < iP.length; p++) {
      if (!isBigEnough(iPOriginal[p], (config.minLines - 1), config.minChars)) { continue; }
      let pHash = hashString(iP[p]);
      if (pHash in allBlockHashes) {
        let file1 = docs[i].filePath;
        let file2 = docs[fullDocHashes[allBlockHashes[pHash]].ind].filePath;
        state.dupedLines += (numLines(iPOriginal[p]) * 2);
        state.numParagraphDupes++;
        if (file1 === file2) {
          state.numParagraphDupesInFile++;
          messages.push(new Message([file1], 2, iPOriginal[p], pHash));
        } else if (hasDuplicateMsg(pHash, messages)) {
          continue;
        } else {
          messages.push(new Message([file1, file2], 1, iPOriginal[p], pHash));
        }
      } else {
        allBlockHashes[pHash] = hash;
      }
    }
  }
  /*
    We just return a value here instead of resolving a promise, because we are not in a promise and do not
    need one because the above operations are synchronous
  */
  return messages;
}

function report (messages) {
  let towelieScore = (100 - ((state.dupedLines / state.totalLines) *  100)).toFixed(2);
  messages.sort(function (a, b) {
    if (a.type > b.type) { return -1; }
    if (a.type < b.type) { return 1; }
    return 0;
  }).forEach(function (msg) {
    console.log(msg.toPlainEnglish());
  });

  console.table([
    {
      "Files Analyzed": state.totalFiles,
      "Lines Analyzed": state.totalLines,
      "Duplicate Files": state.numFileDupes,
      "Duplicate Blocks": state.numParagraphDupes,
      "Duplicate Blocks Within Files": state.numParagraphDupesInFile
    }
  ]);

  if (towelieScore < config.failureThreshold) {
    console.log(chalk.bgRed(`You failed your threshold of ${config.failureThreshold}% with a score of ${towelieScore}%`));
    process.exitCode = 1;
  } else {
    console.log(chalk.bgGreen(`You passed your threshold of ${config.failureThreshold}% with a score of ${towelieScore}%`));
  }
}

function hasDuplicateMsg (hash, msgs) {
  let isDupe = false;
  msgs.forEach(function (msg, ind) {
    isDupe = hash === msg.hash;
    if (isDupe) { return isDupe; }
  });
}

function updateDuplicateMsg (hash, content, msgs) {
  msgs.map(function (msg) {
    if (msg.hash === hash) { msg.content.push(content); }
    return msg;
  });
}

function isBigEnough (p, minLines, minChars) {
  return hasMoreNewlinesThan(p, minLines, true) && p.length > minChars;
}

function hashString (s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function makeParagraphArray (s) {
  return s.split('\n\n');
}

function hasMoreNewlinesThan (p, n, eq) {
  let matches = p.match(/\n/g);
  return eq ? (matches && matches.length >= n) : (matches && matches.length > n);
}

function numLines (s) {
  let matches = s.match(/n/g);
  return matches ? matches.length : 0; 
}

function normalize (arr) {
  return removeEmpty(arr).map(function (s) { return s.replace(/\s/g, ''); });
}

function removeEmpty (arr) {
  return arr.filter(function (arr) { return arr !== ''; });
}

function minify (s) {
  return s.replace(/(\n|\s)/g, '');
}