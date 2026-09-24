#!/bin/bash


set -e

echo "========================================"
echo " Git Add"
echo "========================================"
git add .

echo
echo "========================================"
echo " Git Commit Message: $1"
echo "========================================"
git commit -m "$1"

echo
echo "========================================"
echo " Git Push to Main Branch"
echo "========================================"
git push origin main

echo
echo "========================================"
echo
    echo "Github Push completed."

    echo
echo "========================================"