/* Module dependencies */
var express = require('express')
    , colors = require('colors')
    , fs = require('fs')
    , mustache = require('mustache')
    , everyauth = require('everyauth')
    , path = require('path')
    , JSON5 = require('json5')
    , MongoStore = require('connect-mongostore')(express)
    ;
/* /Module dependencies */


/* Global vars */
global.articlesData = {}; //all-data.json obj with articles by lang (articlesData.en/ru/etc)
global.articlesIDs = {}; //all-data.json ID lists by lang (articlesIDs.en/ru/etc)
global.tagLinks = {}; //global object with tag links
global.sitemap = {}; //global object with sitemap links

global.appDir = path.dirname(require.main.filename); //path to project dir

global.MODE = process.env.NODE_ENV || 'development';

global.app = express();
global.opts = require('./core/options/'); //Global options
global.commonOpts = JSON5.parse(fs.readFileSync(__dirname + '/core/options/common-options.json5', "utf8")); //Common options with Front-end
/* /Global vars */

/*
* Data
* */

global.indexData = {};
global.indexData[global.opts.l18n.defaultLang] = JSON5.parse(fs.readFileSync(__dirname + '/public/index.json5', "utf8"));

//filling lang properties
global.opts.l18n.additionalLangs.map(function(lang) {
    global.indexData[lang] = JSON5.parse(fs.readFileSync(__dirname + '/public/'+lang+'/index.json5', "utf8"));
});


/*
* Express settings
* */

app.configure('development', function(){
  app.use(express.errorHandler());
});

app.configure('production', function(){
    app.use(require('prerender-node').set('prerenderToken', global.opts.prerenderToken));
});


/*
* Update local information from git hub and regenerate all-data.json
* */
var articlesJson = require('./core/generate-data');
require('./core/updateData');

//Preparing initial data on start
articlesJson.generateData();


/**
* Session
*/
app
	.use(express.bodyParser())
	.use(express.cookieParser(global.opts.cookieSecret))
	.use(express.session({
		secret: global.opts.cookieSecret,
		store: new MongoStore({
			'db': 'sessions',
			host: global.opts.remoteDBhost,
			port: global.opts.remoteDBport
		})
	}))
	;

/**
* Localization & geo-ip service
*/
app.use(require('./core/lang'));

//For language switching
app.post('/lang', function (req, res, next) {
    var currentLang = req.body.lang || global.opts.l18n.defaultLang;
	req.session.lang = currentLang;
    res.cookie('lang', currentLang, { maxAge: 3600000, httpOnly: false });

    res.send();
});


/*
* auth module
* */

require('./core/auth');
app.use(everyauth.middleware());

var authDoneTpl = fs.readFileSync(__dirname+'/views/auth-done.html', "utf8");
app.get('/auth/stub', function (req, res) {
    var lang = req.cookies.lang || global.opts.l18n.defaultLang;

    var indexJson = global.indexData[lang];

    indexJson.authDone = false;

    var htmlToSend = mustache.to_html(authDoneTpl, indexJson);

    res.send(htmlToSend);
});

app.get('/auth/done', function (req, res) {
    var lang = req.cookies.lang || global.opts.l18n.defaultLang;

    //Creating cachedAuth for keeping auth after app restart
    req.session.authCache = req.session.auth;

    var indexJson = global.indexData[lang];

    indexJson.user = JSON5.stringify(req.session.authCache.github.user);
    indexJson.authDone = true;

    var htmlToSend = mustache.to_html(authDoneTpl, indexJson);
    res.send(htmlToSend);
});


/*
 * git api form
 * */
if (global.opts.form.enabled) {
    var form = require('./core/form');
    app.get('/post-article', form.postArticle); // preparing encoded data from changed file
}

/**
* Validation
*/
if (global.opts.validate.enabled) {
    var validation = require('./core/check-title'),
        checkUrl = require('./core/check-url-status'),
        validate = require('./core/validate');

    app.get('/check-title', validation.checkTitleService); //Check unique title
    app.get('/check-url', checkUrl.checkURLService); //URL checker
    app.get('/validate', validate.validateService); //Validate all
}

/*
* web routing
* */
// Route for static files
app.set('route', __dirname + '/public');

app
	.use(function(req, res, next) {
		var path = req.path.split('/');

		if (path[1] === 'output') {
			res.setHeader("Cache-Control", "max-age=360000");
		} else {
			res.setHeader("Cache-Control", "max-age=3153600000");
		}
		return next();
	})
	.use(express.compress())
	.use(express.static(app.get('route')))
	;

var preparePageData = function(req){
    var lang = req.session.lang || global.opts.l18n.defaultLang;

    //text resources data
    var data = {records: global.indexData[lang]};

    //for dynamic options update
    data.commonOpts = global.commonOpts;

    //link to tags catalogues for main page
    data.catalogue = global.tagLinks[lang];

    //Auth data
    if (req.session.authCache && typeof req.session.authCache.github.user === 'object' || typeof req.user === 'object') {
        data.auth = true;
        data.authToken = req.session.authCache.github.accessToken;
    } else {
        data.auth = false;
    }

    //Production mode in templates
    if (global.MODE === 'production') { data.production = true; }

    //Preparing for client
    var clientIndexJson = {},
        clientIndexJsonSharedFields = ['commonOpts','auth', 'authToken','records'];

    clientIndexJsonSharedFields.map(function(item){
       clientIndexJson[item] = data[item];
    });

    data.appData = JSON5.stringify(clientIndexJson);

    return data;
};

// Main page
app.get('/', function(req, res) {
	//setting cookie with app mode
	res.cookie('app-mode', global.MODE, { maxAge: 3600000, httpOnly: false });

    var indexJson = preparePageData(req);
    var indexPage = fs.readFileSync(__dirname + '/public/build/index.html', "utf8");
    var htmlToSend = mustache.to_html(indexPage, indexJson);

    res.send(htmlToSend);
});

// Sitemap
app.get('/sitemap.xml', function (req, res) {
    var lang = req.session.lang || global.opts.l18n.defaultLang;

    if (global.sitemap[lang]) {

        global.sitemap[lang].toXML(function (xml) {
            res.header('Content-Type', 'application/xml');
            res.send(xml);
        });

    } else {
        res.send(404, '404');
    }

});

/*
* voting module (requiring order matters)
* */
var voting = require('./core/voting');

if (global.opts.voting.enabled) {
    app.get('/plusVotes', voting.plusVotes); // post arguments: id, user
    app.get('/minusVotes', voting.minusVotes); // post arguments: id, user
    app.get('/getVotes', voting.getVotes); // post arguments: id
    app.get('/getAllVotes', voting.getAllVotes);
}

// Preparing initial data on start
voting.generateVotingData(global.opts.l18n.defaultLang);
global.opts.l18n.additionalLangs.map(function(lang) {
    voting.generateVotingData(lang);
});


/*
* error hadnling
* */

if (global.MODE === 'production') {
    app.use(function(err, req, res, next) {
        console.log(err);
        res.send(404, '404');
    });

    app.use(function(err, req, res, next) {
        console.log(err);
        res.send(500, '500');
    });
}

var appPort = global.MODE === 'development' ? global.opts.app.devPort : global.opts.app.port;

app.listen(appPort);
var appPortString = appPort.toString();
console.log('[DevShelf] is working on '.blue + appPortString.blue + ' port in '.blue + global.MODE.blue + ' mode...'.blue);
