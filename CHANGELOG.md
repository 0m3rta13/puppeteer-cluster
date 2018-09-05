# Changelog
All notable changes to this project will be documented in this file.

## [0.11.0] - 2018-09-05
### Fixed
- Fixed rarely happening bug (issue #3), which made browser not able to restart

## [0.10.0] - 2018-08-21
### Added
- Node.js support for version 6 and 7 added

## [0.9.1] - 2018-07-18
### Fixed
- Circular structures led to crashs in case of crawling errors.

## [0.9.0] - 2018-07-13
### Changed
- Cluster.task function signature changed from `Cluster.task(page, url)` to `Cluster.task({ page, data })`. `Cluster.queue` can be passed any data instead of a string or object.

## 0.8.1 - 2018-07-08
### Fixed
- The timeout-promise for a task was not canceled when a task threw an error.

## 0.8.0 - 2018-07-04
### Added
- Cluster can be used without defining a Cluster.task function by queuing only functions.

### Fixed
- Page errors ("Page crashed!") were not caught so far

### Removed
- maxCPU and maxMemory options removed as they made no sense (better to check how much chromium your machine can handle.)
