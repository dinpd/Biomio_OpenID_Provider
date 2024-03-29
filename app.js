var express = require('express');
var expressSession = require('express-session');
var http = require('http');
var path = require('path');
var cors = require('cors');
var cookie = require('cookie');
var cookieParser = require('cookie-parser');
var querystring = require('querystring');
var rs = require('connect-redis')(expressSession);
var extend = require('extend');
var bodyParser = require('body-parser');
var errorHandler = require('errorhandler');
var _ = require('lodash');
var favicon = require('serve-favicon');
var fs = require('fs');
var BiomioNode = require('biomio-node');

//var https = require('https');
//var privateKey  = fs.readFileSync('/etc/ssl/certs/biom.io.key', 'utf8');
//var certificate = fs.readFileSync('/etc/ssl/certs/biom.io.crt', 'utf8');
//var credentials = {key: privateKey, cert: certificate};



var app = express();
var server = http.Server(app);


var io = require('socket.io')(server);

var connections = {};
var config = require('./config');
var client = require('./controllers/client');
var user = require('./controllers/user');
var auth = require('./controllers/auth');

var env = process.env.NODE_ENV || 'production';

var options = {
  login_url: '/login',
  consent_url: '/user/consent',
  scopes: {
    foo: 'Access to foo special resource',
    bar: 'Access to bar special resource'
  },
  connections: {
    def: {
      adapter: 'redis',
      host: config.redis.host,
      port: config.redis.port
    }
  },
  policies: {
    loggedIn: function(req, res, next) {
      if(req.session.user) {
        next();
      } else {
        var params = {};

        if (req.parsedParams && req.parsedParams['external_token'] !== undefined) {
         params.external_token = req.parsedParams['external_token'];
        }

        params.return_url = req.parsedParams ? req.path + '?' + querystring.stringify(req.parsedParams) : req.originalUrl;
        //console.log('XX', params.return_url);
        res.redirect(this.settings.login_url + '?' + querystring.stringify(params));
      }
    }
  },
  app: app
};

var oidc = require('./services/openid-connect').oidc(options);

if ('development' == app.get('env')) {
  app.use(errorHandler());
}

/* configure template engine */
var exphbs = require('express-handlebars');
var hbs = exphbs.create({
    // Specify helpers which are only registered on this instance.
    defaultLayout: 'main',
    extname: '.hbs'
});
app.engine('.hbs', hbs.engine);
app.set('view engine', '.hbs');

/* set middlewares */
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(cookieParser(config.session.secret));

var sessionStore = new rs(config.redis);

var sessionMiddleware = expressSession({
  store: sessionStore,
  secret: config.session.secret,
  resave: true,
  saveUninitialized: true,
  cookieParser: cookieParser(config.session.secret)
});

app.use(sessionMiddleware);

app.use(function (req, res, next) {
  console.info('REQ:', req.method, req.originalUrl);
  next();
});

app.set('port', process.env.PORT || 5000);

server.listen(app.get('port'));

console.info(config);

try {
  var privateKey = fs.readFileSync(__dirname + '/' + config.appSecretFile).toString();
} catch (e) {
  console.error('Can\'t find/read file "private.key"!');
  process.exit(1);
}

console.info(privateKey);

var gateOptions = {
  gateURL: config.gate.websocketUrl,
  appId: config.appId,
  appKey: privateKey,
  appType: 'extension', // probe | extension | hybrid
  onTry: function(data) {
    console.info('onTry ', data);
    return ["true"];
  },

  /* optional parameters */
  osId: 'linux',
  headerOid: 'clientHeader',
  devId: 'node_js_lib'
}


io.on('connection', function(socket) {
  console.info('a user connected');

  socket.on('check-token', function(externalToken) {
    console.log('check-token: ', externalToken);

    /** if instance is exist - finish it! */
    if(connections[socket.id]) {
      console.info('FINISH');
      connections[socket.id].finish();
      delete connections[socket.id];
    }

    var conn = new BiomioNode(externalToken, gateOptions, function() {
      	
      conn.user_exists(function(exists) {
        console.info('user exists ', exists);
        io.emit('check-token', exists);
      });
      console.info('session', externalToken, socket.id);
      connections[socket.id] = conn;
     
    });

  });

  socket.on('run-auth', function(msg) {
    console.log('run-auth: ', msg);

    var conn = connections[socket.id];
    console.info('run-auth', socket.id);
   // console.info('connections', connections);
    try {
      /* callback will be called few times: in_progress, completed */
      conn.run_auth(function (result) {
        console.log('RUN AUTH STATUS: ' + JSON.stringify(result));

        if (result.status === 'completed') {
          var data = socket.handshake || socket.request;
          var cookies = cookie.parse(data.headers.cookie);
          var sid = cookieParser.signedCookie(cookies[config.session.cookie], config.session.secret);

          sessionStore.get(sid, function (error, sess) {
            sess.user = conn._on_behalf_of;

            sessionStore.set(sid, sess, function (error, result) {
              //console.info('session set: ', error, result);
              error && console.error(error);
            });
          });
        }
        if(io.sockets.connected[socket.id]) {
	  console.info('socket connected', socket.id);
	  io.sockets.connected[socket.id].emit('status', result);
	}
        //io.emit('status', result);
      });

    } catch(ex) {
      console.warn('EXCEPTION: ', ex);
    }

  });

  socket.on('error', function(response) {
    console.warn('SOCKET ON ERROR: ', response);
  });

  socket.on('disconnect', function() {
    console.log('user disconnected');

    if (connections[socket.id]) {
      var conn = connections[socket.id];
      conn.finish();
      delete connections[socket.id];
    } else {
      console.warn('socket id undefined');
    }
  });

});

app.get('/', function(req, res) {
  var user = req.session.user || null;
  res.render('index', {user: user});
});

app.get('/login', auth.login());

//app.all('/logout', oidc.removetokens(), auth.logout(), function(req, res)
app.all('/logout', function(req, res) {
  sessionStore.destroy(req.session.id, function (error, sess) {
    console.info('session destroy: ', error, sess);
    req.session.destroy();
    res.redirect('/');
  });
});

//authorization endpoint
app.get('/user/authorize', oidc.auth());

//token endpoint
app.post('/user/token', oidc.token());

//user consent form
app.get('/user/consent', user.consentForm());

app.post('/user/consent', oidc.consent());

//user creation form
app.get('/user/create', user.createForm());


/** Client routes */
app.get('/client/register', oidc.use('client'), client.registerForm());

//app.post('/client/register', oidc.use('client'), client.registerAction());
app.get('/client/register', client.registerAction());
