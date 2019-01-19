/* @flow */

import type {Url, VisitsMap} from './common';
import {Visit, Visits, unwrap} from './common';
import {normalise_url} from './normalise';
import {getUrlsFile} from './options';

// TODO common?
function showNotification(text: string) {
    if (Notification.permission !== "granted") {
        Notification.requestPermission();
    } else {
        // TODO ugh. is there no way to show in-browser only notification??
        const notification = new Notification(
            'wereyouhere',
            // $FlowFixMe
            {body: text},
        );
    }
}

function rawToVisits(vis): Visits {
    // TODO not sure, maybe we want to distinguish..
    if (vis == null) {
        return new Visits([], []);
    }

    const visits = vis[0];
    const contexts: Array<string> = vis[1];
    return new Visits(visits.map(v => {
        const vtime: string = v[0];
        const vtags: Array<string> = v[1];
        return new Visit(vtime, vtags);
    }), contexts);
}


// TODO better name?
function getJsonVisits(u: Url, cb: (Visits) => void) {
    // TODO ok, here we want to do an async request

    const data = JSON.stringify({
        'url': u,
    });

    const request = new XMLHttpRequest();

    const endpoint = 'http://localhost:13131/visits';
    request.open('POST', endpoint, true);
    request.onreadystatechange = () => {
        if (request.readyState != request.DONE) {
            return;
        }
        const status = request.status;
        const rtext = request.responseText;
        var had_error = false;
        var error_message = `status ${status}, response ${rtext}`;
        console.log(`[background] status: ${status}, response: ${rtext}`);

        if (status >= 200 && status < 400) { // success
            try {
                // TODO handle json parsing defensively here
                const response = JSON.parse(request.response);
                console.log(`[background] success: ${response}`);
                const vis = rawToVisits(response);
                cb(vis);
                // if (options.notification) {
                //     showNotification(`OK: captured to ${path}`);
                // }
            } catch (err) {
                had_error = true;
                error_message = error_message.concat(String(err));
                console.error(err);
            }
        } else {
            had_error = true;
            if (status == 0) {
                error_message = error_message.concat(` ${endpoint} must be unavailable `);
            }
        }

        if (had_error) {
            console.error(`[background] ERROR: ${error_message}`);
            showNotification(`ERROR: ${error_message}`);
            // TODO crap, doesn't really seem to respect urgency...
        }
    };
    request.onerror = () => {
        console.error(request);
    };

    request.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
    request.send(data);
}


function getDelayMs(/*url*/) {
    return 10 * 60 * 1000; // TODO do something smarter... for some domains we want it to be without delay
}

function getChromeVisits(url: Url, cb: (Visits) => void) {
    // $FlowFixMe
    chrome.history.getVisits(
        {url: url},
        function (results) {
            const delay = getDelayMs();
            const current = new Date();
            const times: Array<Date> = results.map(r => new Date(r['visitTime'])).filter(dt => current - dt > delay);
            var groups = [];
            var group = [];

            function dump_group () {
                if (group.length > 0) {
                    groups.push(group);
                    group = [];
                }
            }

            function split_date_time (dt) {
                var d = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
                var spl = d.toISOString().split('Z')[0].split('T');
                return [spl[0], spl[1].substring(0, 5)];
            }

            function format_time (dt) {
                return split_date_time(dt)[1];
            }

            // UGH there are no decent custom time format functions in JS..
            function format_date (dt) {
                var options = {
                    day  : 'numeric',
                    month: 'short',
                    year : 'numeric',
                };
                return dt.toLocaleDateString("en-GB", options);
            }

            function format_group (g) {
                const dts = format_date(g[0]) + " " + format_time(g[0]) + "--" + format_time(g[g.length - 1]);
                const tags = ["chr"];
                return new Visit(dts, tags);
            }

            var delta = 20 * 60 * 1000; // make sure it matches with python
            for (const t of times) {
                const last = group.length == 0 ? t : group[group.length - 1];
                if (t - last > delta) {
                    dump_group();
                }
                group.push(t);
            }
            dump_group();


            var visits = groups.map(format_group);
            visits.reverse();
            // TODO might be a good idea to have some delay for showing up items in extended history, otherwise you will always be seeing it as visited
            // also could be a good idea to make it configurable; e.g. sometimes we do want to know immediately. so could do domain-based delay or something like that?
            cb(new Visits(visits, []));
        }
    );
}

function getMapVisits(url: Url, cb: (Visits) => void) {
    var nurl = normalise_url(url);
    console.log("Original: %s", url);
    console.log("Normalised: %s", nurl);
    getJsonVisits(nurl, v => {
        if (v) {
            cb(v);
        } else {
            cb(new Visits([], []));
        }
    });
}

function getVisits(url: Url, cb: (Visits) => void) {
    if (url.match('chrome://')) {
        console.log("Ignoring %s", url);
        cb(new Visits(
            [],
            []
        ));
        return;
    }


    getChromeVisits(url, function (chr_visits) {
        getMapVisits(url, function (map_visits) {
            cb(new Visits(
                map_visits.visits.concat(chr_visits.visits),
                map_visits.contexts.concat(chr_visits.contexts)
                // TODO actually, we should sort somehow... but with dates as strings gonna be tedious...
                // maybe, get range of timestamps from python and convert in JS? If we're doing that anyway...
                // also need to share domain filters with js...
                // for now just prefer map visits to chrome visits
            ));
        });
    });
}

function getIconAndTitle (visits: Visits) {
    if (visits.visits.length === 0) {
        return ["images/ic_not_visited_48.png", "Was not visited"];
    }
    // TODO a bit ugly, but ok for now.. maybe cut off by time?
    const boring = visits.visits.every(v => v.tags.length == 1 && v.tags[0] == "chr");
    if (boring) {
        return ["images/ic_boring_48.png"     , "Was visited (boring)"];
    } else {
        return ["images/ic_visited_48.png"    , "Was visited!"];
    }
}

function updateState () {
    // TODO ugh no simpler way??
    chrome.tabs.query({'active': true}, function (tabs) {
        // TODO why am I getting multiple results???
        let atab = tabs[0];
        let url = unwrap(atab.url);
        // $FlowFixMe
        let tabId = atab.tabId;
        getVisits(url, function (visits) {
            let res = getIconAndTitle(visits);
            let icon = res[0];
            let title = res[1];
            chrome.browserAction.setIcon({
                path: icon,
                tabId: tabId,
            });
            chrome.browserAction.setTitle({
                title: title,
                tabId: tabId,
            });

            // TODO maybe store last time we showed it so it's not that annoying... although I definitely need js popup notification.
            if (visits.contexts.length > 0) {
                showNotification('contexts are available for this link!');
            }
        });
    });
}

// ok, looks like this one was excessive..
// chrome.tabs.onActivated.addListener(updateState);


chrome.tabs.onUpdated.addListener(updateState);
// chrome.tabs.onReplaced.addListener(updateState);

// $FlowFixMe
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.method == 'getVisits') {
        chrome.tabs.query({'active': true}, function (tabs) {
            var url = unwrap(tabs[0].url);
            getVisits(url, function (visits) {
                sendResponse(visits);
            });
        });
        return true; // this is important!! otherwise message will not be sent?
    }
    return false;
});

// TODO what about default listener??
chrome.browserAction.onClicked.addListener(tab => {
    chrome.tabs.executeScript(tab.id, {file: 'sidebar.js'});
});