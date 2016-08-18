module.exports = function(items) {
  // find longest
  var max = 0;
  Object.keys(items).forEach(function(left) {
    var right = items[left];

    var possible = left + ":  " + right;

    if (possible.length > max) {
      max = possible.length;
    }
  });

  // Now do the aligning
  Object.keys(items).forEach(function(left) {
    var right = items[left];

    var str = left + ": ";

    while ((str + right).length < max) {
      str = str + " ";
    }

    console.log(str + right);
  })
}
