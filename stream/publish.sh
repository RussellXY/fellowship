#! /bin/bash

cd /Users/victor/Documents/web_project/fellowship/stream
npm run build

cd ..

rm -rf public/stream
cp -r stream/dist public/stream
