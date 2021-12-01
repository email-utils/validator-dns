#!/bin/bash

if [ $1 ]; then
  echo "Creating a new $1 version."

  npm version $1
  version=`node -e "console.log(require('./package.json').version);"`

  npm run build
  git add -A
  git commit -m "Build for $version."

  echo "Publishing version $version."

  git push
  git push --tags
  npm publish --access public
else
  echo "No version type provided. (ie. ./bin/tag.sh version)";
fi

